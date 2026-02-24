# R&D Findings: Dynamic Belief System (Semantic Memory)

**Date:** 2026-02-24
**Feature Summary:** Add a dynamic belief system to Engram that extracts generalizations from episodes, tracks them as living hypotheses with Bayesian confidence, and surfaces them as belief bites alongside memory bites in memory_recall. Beliefs strengthen with reinforcement, weaken with contradictions, decay over time, and can be revised/split/merged. Both project-scoped and global beliefs.

## Codebase Analysis

### Episode Storage (mcp/schema.ts)
- Schema version 8, migrations v1-v8. Next migration = v9.
- Episodes table: id (ep_*), summary, entities, importance, embedding (768-dim nomic-embed BLOB), created_at, accessed_at, access_count, scope (global|project), project, project_path
- FTS5 virtual table `episodes_fts` indexes summary + entities, rowid-based join pattern
- Migration pattern: BEGIN EXCLUSIVE, BUSY retry with 6s sleep, version gate

### Processor Daemon (processor/index.ts)
- HTTP-over-UDS server at ~/.claude-memory/engram.sock
- Episode creation: SessionTailer.processEntry() -> extract() -> extractMemories() (LLM) -> batchEmbedCandidates() -> upsertEpisode()
- **Key hook point**: runConsolidation(db) runs every 4h via setInterval. Belief consolidation fits here.
- Hot trigger possible in SessionTailer.extract() after upsert loop (when added > 0)
- openaiClient constructed in index.ts but NOT passed to runConsolidation() — needs wiring

### Recall Pipeline
- **writeRecollections** (pre-computed, hook-triggered): BM25 + vector pool (200) + RRF fusion (4 rank lists: BM25 W=0.4, Vector W=1.0, Recency W=0.6, Access W=0.4) -> top 3 filtered by MIN_VECTOR_SIM=0.25
- Output: MemoryBite[] with format `[Memory flash: {summary}]`
- **handleMemoryRecall** (agent-initiated): BM25 + recent episodes, weighted scoring (0.5*relevance + 0.3*recency + 0.2*access), updates accessed_at
- **handleMemoryExpand**: Fetches by ID, increments access_count, returns full card

### Existing Consolidator (processor/consolidator.ts)
- runConsolidation(db) -> graduateEpisodes(db) + compressStaleEpisodes(db)
- Graduation: high-importance + access_count >= 3 OR > 14 days -> MEMORY.md
- Compression: > 30 days, access_count=0, normal importance -> null full_content
- Uses withFileLock, max 10 graduations per cycle

### Integration Points
| File | Change |
|------|--------|
| mcp/schema.ts | v9 migration: beliefs table + beliefs_fts |
| processor/consolidator.ts | Add runBeliefConsolidation() |
| processor/recollection-writer.ts | Query beliefs, append belief bites to output |
| mcp/server.ts | Blend beliefs into handleMemoryRecall, update memory_expand for beliefs |
| processor/index.ts | Wire openaiClient to runConsolidation() |
| NEW: processor/belief-consolidator.ts | Core belief extraction and lifecycle logic |

## Best Practices Research

### Recommended Architecture: Event-Sourced Beliefs
Episodes are immutable events. Beliefs are materialized views (projections) derived from episodes via incremental consolidation. Beliefs are disposable/rebuildable from source episodes.

### Key References
1. **Park et al. 2023** ("Generative Agents") — reflection mechanism, importance-threshold triggering, recursive abstraction
2. **MemGPT/Letta** — tiered memory (core/archival), self-directed management
3. **Cortex (Context Studios)** — production episodic->semantic consolidation with vector clustering + LLM synthesis
4. **Event Sourcing + CQRS** — append-only events, materialized view projections

### Consolidation Pipeline Pattern
1. EXTRACT: Scan recent unprocessed episodes
2. CLUSTER: Group by vector similarity (threshold ~0.75)
3. SYNTHESIZE: LLM per cluster -> candidate belief
4. MATCH: Compare candidate against existing beliefs
   - High similarity -> REINFORCE (increase confidence)
   - Contradiction -> FLAG for revision
   - Novel -> CREATE new belief
5. DECAY: Reduce confidence of unreinforced beliefs
6. PRUNE: Archive beliefs below minimum confidence

### Critical Warnings
- **Hallucinated beliefs**: LLMs over-generalize from sparse data. Require 3+ episodes minimum.
- **Belief drift**: Recursive reflections compound errors. Cap abstraction depth.
- **Premature forgetting**: Never delete, only archive. High-importance beliefs decay slower.
- **Cold start**: No consolidation until minimum episode threshold.
- **Computational cost**: Batch consolidation, embeddings for clustering (cheap), LLM only for synthesis.

## Neuroscience Research

### Complementary Learning Systems (CLS)
- **Hippocampus** = fast episodic encoding (our episodes table)
- **Neocortex** = slow semantic integration (our beliefs table)
- **Systems consolidation** = offline replay transfers episodes -> semantics (our consolidation loop)
- **Go-CLS (2023)**: Only consolidate when it aids generalization. Not all episodes become beliefs.

### Reconsolidation Theory (Nader et al.)
- Retrieved memories become temporarily labile and can be updated
- **Prediction error (PE)** is the trigger — mismatch between expected and observed
- Older/stronger memories require stronger PE to destabilize
- Design: When a belief is accessed and contradicted, open an update window. Magnitude of PE determines whether update occurs.

### Bayesian Brain / Precision Weighting
- `posterior = (likelihood * prior) / evidence`
- **Precision weighting**: learning_rate = evidence_precision / (belief_precision + evidence_precision)
- High-confidence beliefs barely shift from single contradictions
- Each confirming observation increases precision (confidence grows with evidence)
- **Key equation**: `new_confidence = old_confidence + evidence_precision`

### Forgetting: Bjork's Dual Strength Model
- **Storage strength**: How well-embedded (evidence_count). Only increases.
- **Retrieval strength**: How accessible now (recency). Decays with disuse.
- **Decay formula**: R(t) = e^(-t/S) where S = stability parameter
- Each retrieval increases S (stability), extending decay curve
- **Don't delete, deprioritize**: Low retrieval strength = not surfaced proactively, but still exists

### Schema Theory
- Schemas = generalized knowledge frameworks from repeated experience = our beliefs
- Schema-consistent info → rapid assimilation (reinforce belief)
- Schema-inconsistent info → prediction error → possible belief update
- Risk: false memories from schema-consistent inference

### Synthesized Design Equations
```
# Bayesian update
learning_rate = evidence_precision / (belief.confidence + evidence_precision)
belief.confidence += evidence_precision  # Each observation adds precision

# Retrieval strength decay
retrieval_strength = e^(-(now - last_accessed) / stability)

# Destabilization threshold (boundary conditions)
destab_threshold = base_threshold * log(1 + evidence_count) * log(1 + age_days)

# Spaced retrieval bonus
stability *= (1 + spacing_bonus(time_since_last_retrieval))
```

## SQLite Documentation

### Beliefs Table Design
- Separate beliefs_fts FTS5 table (not shared with episodes_fts)
- Blended search via UNION ALL across both FTS5 tables
- JSON columns for episode ID arrays (supporting/contradicting) — simpler than junction tables for our access patterns
- FTS5 sync triggers (ai/ad/au) for external content tables
- Application-layer consolidation trigger (not SQLite triggers) — consolidation requires async LLM calls

### Key Patterns
- rowid-based FTS5 join (never join on id column)
- json_insert for appending to arrays, json_each for querying
- bun:sqlite transactions via db.transaction() for atomic belief upserts
- WAL mode for concurrent reads during consolidation

## Key Insights
1. **Neuroscience directly maps to software**: CLS = two-table architecture, reconsolidation = belief update on access, Bayesian brain = confidence-weighted updating, Bjork = dual strength decay model
2. **Prediction error is the universal gate**: Both for forming new beliefs (novel pattern detection) and updating existing ones (contradiction detection)
3. **The consolidation loop already exists**: runConsolidation() in processor/consolidator.ts runs every 4h — belief consolidation slots in cleanly
4. **Beliefs are materialized views**: Can always be rebuilt from episodes. This makes the system robust to bugs in the belief logic.

## Assumptions to Validate
- 3-episode minimum for belief formation is sufficient (importance: high, evidence: medium)
- 4h consolidation interval is frequent enough for useful beliefs (importance: high, evidence: low)
- Vector similarity threshold ~0.75 for clustering is appropriate (importance: medium, evidence: low)
- LLM-generated belief text is reliable enough without human review (importance: high, evidence: medium)
