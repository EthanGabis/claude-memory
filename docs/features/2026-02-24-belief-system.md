# Belief System (Semantic Memory)

**Date:** 2026-02-24
**Status:** Implemented
**Plan:** docs/plans/2026-02-24-belief-system.md
**R&D:** docs/rnd/2026-02-24-belief-system.md

## Overview

Engram now has a semantic memory layer that extracts generalizations from episodic memory into beliefs with Bayesian confidence tracking. Beliefs are living hypotheses that strengthen with reinforcement, weaken with contradictions, and are surfaced alongside episode-based memory bites during recall -- giving Claude a dual episodic/semantic memory system modeled on how the human brain consolidates experience into knowledge.

## How It Works

The system follows a batch consolidation pipeline that runs during the existing 4-hour cold consolidation cycle:

1. **Extract** -- The consolidator reads all episodes created since the last belief checkpoint (tracked via `_meta` table key `belief_consolidation_checkpoint`). It skips work if fewer than 20 new episodes have accumulated.

2. **Cluster** -- Episodes are grouped by embedding similarity (cosine threshold 0.70). Only clusters with 3 or more episodes proceed, preventing hallucinated beliefs from sparse data.

3. **Synthesize** -- Each cluster is sent to `gpt-4.1-mini` with a structured prompt that extracts one generalized belief statement plus structured fields (subject, predicate, context, timeframe). The prompt enforces falsifiability and prohibits inference beyond the evidence.

4. **Match** -- Each candidate belief's embedding is compared against all active beliefs. If cosine similarity exceeds 0.92, the existing belief is reinforced (alpha incremented). If similarity is between 0.70 and 0.92, a 4-way LLM classification (SUPPORTS / CONTRADICTS / PARTIAL / IRRELEVANT) determines the action. Below 0.70, the candidate is treated as novel.

5. **Lifecycle checks** -- After matching, the pipeline runs rule-based gates for revision, split, merge, and archival on affected beliefs.

6. **Decay** -- Beliefs not reinforced in this cycle are evaluated for archival. Retrieval strength decays exponentially at query time (not during consolidation).

7. **Surface** -- During recall, beliefs are queried via BM25 and vector similarity, scored with an additive weighted sum, filtered by confidence, and returned as belief bites alongside episode memory bites. Up to 2 belief bites are included per recall.

The entire pipeline is budget-capped at 2 minutes per cycle, with a maximum of 10 clusters processed and 5 classification calls per cluster. If the budget is exceeded, the pipeline saves progress and picks up remaining work in the next cycle.

## Neuroscience Grounding

The belief system is grounded in five neuroscience frameworks:

- **Complementary Learning Systems (CLS)** -- The episodes table acts as the hippocampus (fast episodic encoding), while the beliefs table acts as the neocortex (slow semantic integration). Batch consolidation models the offline replay that transfers episodic traces into generalized knowledge. Following Go-CLS (2023), not all episodes become beliefs -- only those that form coherent clusters.

- **Reconsolidation Theory** -- When a belief is retrieved and encounters contradicting evidence, it enters a labile state where updates can occur. The prediction error (mismatch between belief and new episode) is the trigger. The destabilization threshold ensures older, well-evidenced beliefs require stronger prediction errors to change.

- **Bayesian Brain / Precision Weighting** -- Confidence is tracked as a Beta-Bernoulli distribution (alpha/beta counts). Each supporting observation increments alpha; each contradiction increments beta. Confidence naturally converges with evidence, and beliefs with high total evidence resist change -- a direct implementation of Bayesian precision weighting.

- **Bjork's Dual-Strength Model** -- Each belief has both storage strength (evidence_count, monotonically increasing) and retrieval strength (exponential decay from last_accessed_at, modulated by stability). Storage strength never decreases, but retrieval strength fades with disuse. Beliefs are never deleted, only deprioritized.

- **Spaced Repetition** -- Stability increases with spaced retrievals. The bonus is proportional to the log of the time gap since last access, meaning longer gaps between retrievals produce larger stability gains. This mirrors the spacing effect observed in human memory.

## Belief Lifecycle

1. **Creation** -- A cluster of 3+ similar episodes is synthesized into a candidate belief via LLM. If no existing belief matches (cosine < 0.70), a new belief is created with alpha=1, beta=1 (uniform prior), status `active`.

2. **Reinforcement** -- When a new episode or cluster matches an existing belief with cosine > 0.92 and is classified as SUPPORTS, alpha is incremented and the episode ID is appended to supporting_episodes. evidence_count increases. last_reinforced_at is updated.

3. **Contradiction** -- When a related episode (cosine 0.70-0.92) is classified as CONTRADICTS, beta is incremented and the episode ID is appended to contradicting_episodes.

4. **Revision** -- Triggered when confidence drops below 0.4 (having previously been above 0.5), with at least 3 contradicting episodes and evidence_count >= 5. The belief statement is re-synthesized from all evidence. The old belief is marked `revised` and a new belief is created with updated statement and a parent_belief_id link.

5. **Split** -- Triggered when a belief has 3+ contradictions AND 3+ supports, at least 2 PARTIAL classifications, and evidence_count >= 5. The belief is broken into context-specific sub-beliefs. The original is marked `split` and child beliefs are created.

6. **Merge** -- Triggered when two active beliefs have cosine > 0.92, same scope and project, both with confidence > 0.6, and neither revised in the last 7 days. One belief absorbs the other; the merged belief is marked `merged`. Only one pair is merged per cycle.

7. **Decay** -- Retrieval strength decays exponentially: `R(t) = e^(-t/S)` where S is the stability parameter in days. Each retrieval increases stability via a spaced-repetition bonus: `S *= (1 + 0.1 * ln(1 + hours_since_last/24))`, capped at 365 days.

8. **Archival** -- A belief is archived (status `archived`) if confidence drops below 0.3, or if it has not been reinforced in 90 days and has fewer than 5 pieces of evidence. Archived beliefs are retained in the database but no longer surfaced in recall.

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `mcp/schema.ts` | Modified | Added v9 migration: beliefs table, beliefs_fts virtual table, FTS5 sync triggers (ai/ad/au), indices on status/scope/project_path, and the `Belief` TypeScript interface. |
| `processor/belief-utils.ts` | Created | Utility functions for the belief system: `generateBeliefId`, `beliefConfidence`, `retrievalStrength`, `updateStability`, `destabilizationThreshold`, `shouldArchive`, `shouldRevise`, `shouldSplit`, `shouldMerge`, and the `BELIEF_CONFIG` constants object. |
| `processor/belief-consolidator.ts` | Created | Core consolidation pipeline: episode extraction, vector clustering, LLM synthesis, candidate matching, reinforcement/contradiction handling, split/merge/revision with rule-based gates, decay and archival checks, checkpoint management, and budget enforcement. |
| `processor/consolidator.ts` | Modified | Added call to `runBeliefConsolidation()` from the existing `runConsolidation()` function so belief consolidation runs alongside episode graduation and compression in the 4-hour cycle. |
| `processor/index.ts` | Modified | Wired the existing OpenAI client to the consolidation pipeline so belief synthesis and classification calls have access to the LLM. |
| `processor/recollection-writer.ts` | Modified | Added belief querying (BM25 + vector) and formatting. Belief bites are appended to recollection output alongside memory bites in the format `[Belief (0.85): statement]`. |
| `mcp/server.ts` | Modified | Blended beliefs into `handleMemoryRecall` results with `type: 'belief'` tag. Added `bl_*` ID handling to `handleMemoryExpand` (returns full belief card with confidence breakdown, evidence chains, revision history) and `handleMemoryForget` (deletes belief). Updated `memory_status` to include belief count. Updated tool descriptions for recall, expand, and forget to reference beliefs. |

## Architecture Decisions

- **Cold-only consolidation** -- Belief consolidation runs only during the existing 4-hour cold cycle, not on every episode insertion. This avoids blocking the critical path of episode extraction and keeps daemon latency predictable. The hot trigger was considered and removed per Codex review.

- **Beta-Bernoulli confidence** -- V1 uses a simple Beta distribution (alpha/beta counts) instead of full Bayesian precision weighting. Confidence is `alpha / (alpha + beta)`. This is transparent, debuggable, and has the correct Bayesian property that well-evidenced beliefs naturally resist change. More complex models can be swapped in later.

- **Additive scoring for retrieval** -- Beliefs are scored with `0.5 * (confidence * vectorSim) + 0.3 * retrievalStrength + 0.2 * bm25Score`, matching the additive weighted-sum pattern already used in `handleMemoryRecall` for episodes. This keeps scoring consistent across the system.

- **Rule-based gates for destructive operations** -- Split, merge, revision, and archival are all gated by deterministic thresholds (minimum evidence counts, confidence levels, cooldown periods). No LLM call decides whether to destroy or restructure a belief. This prevents hallucinated lifecycle transitions.

- **4-way classification** -- The classification prompt uses SUPPORTS / CONTRADICTS / PARTIAL / IRRELEVANT instead of a binary supports/contradicts. PARTIAL is critical for preventing false contradictions and for triggering the split gate. IRRELEVANT prevents unrelated episodes from polluting belief evidence chains.

- **Beliefs as materialized views** -- Beliefs are derived projections from immutable episodes and can be rebuilt from scratch. This makes the system robust to bugs in belief logic -- the worst case is dropping the beliefs table and re-running consolidation.

## Configuration

All constants are defined in `BELIEF_CONFIG` in `processor/belief-utils.ts`:

| Constant | Default | Description |
|----------|---------|-------------|
| `EPISODE_THRESHOLD` | 20 | Minimum new episodes before a consolidation cycle runs |
| `MIN_CLUSTER_SIZE` | 3 | Minimum episodes required to form a belief (prevents hallucinated generalizations) |
| `CLUSTER_SIMILARITY_THRESHOLD` | 0.70 | Cosine similarity threshold for grouping episodes into clusters |
| `REINFORCE_THRESHOLD` | 0.92 | Cosine similarity above which a candidate reinforces an existing belief |
| `RELATED_THRESHOLD` | 0.70 | Cosine similarity above which a candidate is checked for contradiction |
| `MIN_CONFIDENCE_FOR_RECALL` | 0.4 | Beliefs below this confidence are not surfaced in recall |
| `REVISION_CONFIDENCE_THRESHOLD` | 0.4 | Confidence below which revision is triggered (if other gates pass) |
| `ARCHIVE_CONFIDENCE_THRESHOLD` | 0.3 | Confidence below which a belief is archived |
| `SPLIT_MIN_CONTRADICTIONS` | 3 | Minimum contradicting episodes to allow a split |
| `SPLIT_MIN_SUPPORTS` | 3 | Minimum supporting episodes to allow a split |
| `SPLIT_MIN_PARTIAL_COUNT` | 2 | Minimum PARTIAL classifications to allow a split |
| `SPLIT_MIN_EVIDENCE` | 5 | Minimum total evidence to allow a split |
| `MERGE_MIN_SIMILARITY` | 0.92 | Cosine similarity required for merge candidates |
| `MERGE_MIN_CONFIDENCE` | 0.6 | Minimum confidence for both beliefs in a merge |
| `MERGE_COOLDOWN_DAYS` | 7 | Days since last update before a belief is eligible for merge |
| `ARCHIVE_STALE_DAYS` | 90 | Days without reinforcement before stale+weak beliefs are archived |
| `ARCHIVE_MIN_EVIDENCE` | 5 | Evidence count above which stale beliefs are not archived |
| `MAX_BELIEF_BITES` | 2 | Maximum belief bites returned per recall query |
| `MAX_CLUSTERS_PER_CYCLE` | 10 | Maximum clusters processed per consolidation cycle |
| `MAX_CLASSIFICATIONS_PER_CLUSTER` | 5 | Maximum existing beliefs checked per candidate (top-5 by similarity) |
| `PER_CALL_TIMEOUT_MS` | 10,000 | Timeout per individual LLM call (10 seconds) |
| `MAX_CYCLE_BUDGET_MS` | 120,000 | Total time budget per consolidation cycle (2 minutes) |
| `SYNTHESIS_MODEL` | `gpt-4.1-mini` | Model used for belief synthesis from episode clusters |
| `CLASSIFICATION_MODEL` | `gpt-4.1-mini` | Model used for 4-way relationship classification |

## Known Limitations

- **`destabilizationThreshold` is computed but unused** -- The function exists in `belief-utils.ts` but is not currently called in the consolidation pipeline. It was designed for reconsolidation boundary conditions (old beliefs resist change) but the current Beta-Bernoulli model already provides natural resistance via accumulated alpha+beta counts. It may be wired in for V2.

- **Hot trigger removed** -- The plan originally considered triggering belief consolidation immediately after episode insertion. This was removed per Codex review to avoid blocking the episode extraction critical path. Beliefs are only updated during the 4-hour cold cycle.

- **Episode/belief score normalization is approximate** -- Belief scores and episode scores use different weighting schemes in recall blending. They are not normalized to a common scale, so the relative ranking between episodes and beliefs depends on the raw score magnitudes. This works well in practice but is not theoretically clean.

- **Merge processes one pair per cycle** -- To limit complexity and prevent cascading merges, only one pair of beliefs is merged per consolidation cycle. If many beliefs are merge-eligible, it may take several cycles to converge.

- **No manual pinning** -- The archive gate checks for a "manually pinned" flag (noted as a future feature in the plan) but this is not yet implemented. All beliefs are subject to archival based on confidence and staleness.

- **Singleton episodes do not create beliefs** -- An episode that does not cluster with at least 2 others (forming a cluster of 3+) will never produce a belief on its own, even if it contains an important generalization. This is intentional to prevent hallucinated beliefs but may miss some genuine patterns.

## Testing Notes

Verification checklist for the belief system:

- **Schema migration** -- Run on an existing database to confirm v9 migration creates the beliefs table, beliefs_fts, triggers, and indices without errors. Verify idempotency (running twice is safe).
- **Belief creation** -- Accumulate 20+ episodes in a project, trigger consolidation, and verify that beliefs are created with coherent statements and structured fields.
- **Recall blending** -- Run `memory_recall` and verify that belief bites appear alongside episode memory bites. Check the `[B]` tag format and confidence display.
- **Expand for beliefs** -- Call `memory_expand` with a `bl_*` ID and verify the full belief card is returned: statement, subject, predicate, context, timeframe, confidence (alpha/beta breakdown), status, evidence count, supporting/contradicting episode IDs, revision history, and parent/child chain.
- **Forget for beliefs** -- Call `memory_forget` with a `bl_*` ID and verify the belief is deleted from the beliefs table and cleaned up from beliefs_fts.
- **Project scoping** -- Verify that project-scoped beliefs only surface when querying within their project, and global beliefs surface everywhere.
- **Budget enforcement** -- Verify that consolidation cycles respect the 2-minute budget and 10-cluster cap, aborting gracefully and saving progress when exceeded.
- **Confidence updates** -- Verify alpha increments on SUPPORTS classification and beta increments on CONTRADICTS classification.
- **Lifecycle gates** -- Test that revision, split, merge, and archival only trigger when all rule-based gate conditions are met.
- **memory_status** -- Verify the status tool reports the belief count alongside episode counts.
