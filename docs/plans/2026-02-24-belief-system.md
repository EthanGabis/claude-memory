# Implementation Plan: Dynamic Belief System (Semantic Memory)

**Date:** 2026-02-24
**Status:** Reviewed
**R&D:** [docs/rnd/2026-02-24-belief-system.md](../rnd/2026-02-24-belief-system.md)
**Approach:** Option B — Neuroscience-Grounded Full System (with Codex-recommended guardrails)

---

## Feature Summary

Add a dynamic belief system to Engram that extracts generalizations from episodes into beliefs with confidence tracking, integrates them into retrieval as "belief bites" alongside "memory bites", and supports the full belief lifecycle: reinforcement, contradiction, revision, splitting, merging, decay, and archival. Both project-scoped and global beliefs.

**Grounded in neuroscience:** Complementary Learning Systems (episodic→semantic consolidation), reconsolidation theory (prediction error triggers updates), Bayesian precision weighting (confidence determines update resistance), Bjork's dual-strength model (storage strength + retrieval strength).

**Adjusted per Codex critique:** Use gpt-4.1-mini (not nano) for synthesis/classification. Structured belief fields as canonical state. Rule-based gating before destructive ops. 4-way classification. Simple Beta-Bernoulli confidence for V1.

---

## Architecture Overview

```
Episodes (existing)          Beliefs (new)
┌──────────────┐            ┌──────────────────┐
│ ep_* rows    │            │ bl_* rows         │
│ summary      │──extract──▶│ statement (text)  │
│ entities     │            │ subject/predicate │
│ embedding    │            │ confidence (α,β)  │
│ importance   │            │ scope/project     │
│ created_at   │            │ embedding         │
│ accessed_at  │            │ evidence chains   │
└──────────────┘            │ status/lifecycle  │
       │                    └──────────────────┘
       │                           │
       ▼                           ▼
┌──────────────────────────────────────┐
│         memory_recall / recollect    │
│  [Memory flash: ...] + [Belief: ...] │
└──────────────────────────────────────┘
```

---

## Data Model

### beliefs table (schema v9)

```sql
CREATE TABLE IF NOT EXISTS beliefs (
  id              TEXT PRIMARY KEY,          -- 'bl_' + 12-char hex
  statement       TEXT NOT NULL,             -- natural language belief text
  subject         TEXT,                      -- structured: what entity
  predicate       TEXT,                      -- structured: what property/action
  context         TEXT,                      -- structured: when/where this applies
  timeframe       TEXT,                      -- 'current' | 'past' | 'always'
  confidence_alpha REAL NOT NULL DEFAULT 1,  -- Beta-Bernoulli α (support count + prior)
  confidence_beta  REAL NOT NULL DEFAULT 1,  -- Beta-Bernoulli β (contradict count + prior)
  scope           TEXT NOT NULL DEFAULT 'global',  -- 'global' | 'project'
  project         TEXT,                      -- project name if scope='project'
  project_path    TEXT,                      -- project full path
  supporting_episodes   TEXT NOT NULL DEFAULT '[]',  -- JSON array of ep_* IDs
  contradicting_episodes TEXT NOT NULL DEFAULT '[]', -- JSON array of ep_* IDs
  revision_history TEXT NOT NULL DEFAULT '[]',       -- JSON array of {timestamp, old_statement, old_confidence, reason}
  -- INVARIANT: Revised/split beliefs get NEW bl_* IDs. Never reuse IDs (would break FTS rowid mapping).
  parent_belief_id TEXT,                     -- for split/merge/revision chains
  child_belief_ids TEXT NOT NULL DEFAULT '[]',       -- JSON array of bl_* IDs
  embedding       BLOB,                     -- 768-dim nomic-embed
  status          TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'revised' | 'merged' | 'split' | 'archived'
  evidence_count  INTEGER NOT NULL DEFAULT 0,        -- storage strength (monotonic)
  stability       REAL NOT NULL DEFAULT 1.0,         -- S parameter for retrieval decay
  created_at      INTEGER NOT NULL,          -- ms timestamp
  updated_at      INTEGER NOT NULL,          -- ms timestamp
  last_reinforced_at INTEGER,                -- ms timestamp of last supporting evidence
  last_accessed_at   INTEGER,                -- ms timestamp of last retrieval
  access_count    INTEGER NOT NULL DEFAULT 0 -- retrieval count
);

-- FTS5 for belief text search
CREATE VIRTUAL TABLE IF NOT EXISTS beliefs_fts USING fts5(
  statement,
  subject,
  predicate,
  context,
  content='beliefs',
  content_rowid='rowid'
);

-- Sync triggers
CREATE TRIGGER IF NOT EXISTS beliefs_ai AFTER INSERT ON beliefs BEGIN
  INSERT INTO beliefs_fts(rowid, statement, subject, predicate, context) VALUES (new.rowid, new.statement, new.subject, new.predicate, new.context);
END;
CREATE TRIGGER IF NOT EXISTS beliefs_ad AFTER DELETE ON beliefs BEGIN
  INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, subject, predicate, context) VALUES('delete', old.rowid, old.statement, old.subject, old.predicate, old.context);
END;
CREATE TRIGGER IF NOT EXISTS beliefs_au AFTER UPDATE ON beliefs BEGIN
  INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, subject, predicate, context) VALUES('delete', old.rowid, old.statement, old.subject, old.predicate, old.context);
  INSERT INTO beliefs_fts(rowid, statement, subject, predicate, context) VALUES (new.rowid, new.statement, new.subject, new.predicate, new.context);
END;

-- Indices
CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(status);
CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON beliefs(scope);
CREATE INDEX IF NOT EXISTS idx_beliefs_project_path ON beliefs(project_path);
-- No confidence index needed — beliefs table is small enough for full scan. Confidence is computed as alpha/(alpha+beta).

-- Meta table bump
UPDATE _meta SET value = '9' WHERE key = 'schema_version';
```

### Confidence Model: Beta-Bernoulli (V1)

Instead of complex Bayesian precision weighting, use the Beta distribution:
- `confidence = α / (α + β)` — the mean of Beta(α, β)
- Supporting evidence: `α += 1`
- Contradicting evidence: `β += 1`
- Initial prior: α=1, β=1 (uniform/uninformative)
- Effective confidence range: 0.0 to 1.0

Properties:
- 10 supports, 0 contradictions → confidence = 11/12 = 0.917
- 10 supports, 3 contradictions → confidence = 11/14 = 0.786
- 1 support, 1 contradiction → confidence = 2/4 = 0.5 (uncertain)
- High α+β = more evidence = harder to shift (natural Bayesian property)

### Retrieval Strength (Dual-Strength Decay)

```typescript
function retrievalStrength(belief: Belief, now: number): number {
  if (!belief.last_accessed_at) return 0.5; // never accessed = neutral
  const hoursSinceAccess = (now - belief.last_accessed_at) / (1000 * 60 * 60);
  return Math.exp(-hoursSinceAccess / (belief.stability * 24)); // stability in days
}
```

Each retrieval: `stability = Math.min(stability * (1 + 0.1 * Math.log(1 + hoursSinceLastAccess / 24)), 365)` (capped at 365 days)
(Spaced repetition bonus: larger gaps between retrievals = bigger stability increase)

### Destabilization Threshold

```typescript
function destabilizationThreshold(belief: Belief): number {
  const BASE = 0.3;
  const evidenceFactor = Math.log(1 + belief.evidence_count);
  const ageDays = (Date.now() - belief.created_at) / (1000 * 60 * 60 * 24);
  const ageFactor = Math.log(1 + ageDays);
  return BASE * evidenceFactor * ageFactor;
}
```
Old, well-evidenced beliefs need stronger prediction error to destabilize.

---

## Consolidation Pipeline

### Trigger
- **Primary**: After every N new episodes (configurable, default N=20)
- **Secondary**: Inside existing `runConsolidation()` which runs every 4h (cold consolidation only — no hot trigger to avoid blocking episode extraction)
- Track last consolidation checkpoint via `_meta` table key: `belief_consolidation_checkpoint`

### Pipeline Steps

```
1. EXTRACT: Get episodes since last checkpoint
2. CLUSTER: Group by vector similarity (threshold calibrated empirically, starting 0.70)
3. SYNTHESIZE: gpt-4.1-mini per cluster → structured belief candidate
4. MATCH: Compare candidate embedding against existing active beliefs
   4a. cosine > 0.92 → REINFORCE (increment α)
   4b. cosine > 0.70 AND classified as CONTRADICTS → CONTRADICT (increment β, check destab)
   4c. cosine < 0.70 → NOVEL (create new belief if cluster has 3+ episodes)
5. DECAY: For all active beliefs not reinforced in this cycle:
   - No action on retrieval strength (handled at query time)
   - Run archive gate: confidence < 0.3, OR (last_reinforced_at > 90 days AND evidence_count < 5)
6. SPLIT/MERGE CHECK: Rule-based gates (see below)
7. UPDATE CHECKPOINT
```

### Consolidation Budget (prevents runaway LLM calls)

```typescript
const MAX_CLUSTERS_PER_CYCLE = 10;
const MAX_CLASSIFICATIONS_PER_CLUSTER = 5;  // only check top-5 similar existing beliefs
const PER_CALL_TIMEOUT_MS = 10_000;         // 10s per LLM call
const MAX_CYCLE_BUDGET_MS = 120_000;        // abort if cycle exceeds 2 minutes
```

The pipeline tracks elapsed time and aborts gracefully (saving progress) if the budget is exceeded. Remaining work is picked up in the next cycle.

### Synthesis Prompt (gpt-4.1-mini)

```
You are extracting a generalized belief from a cluster of memory episodes.

Episodes:
{{EPISODES}}

Extract ONE belief statement that generalizes across these episodes. Also extract structured fields.

Respond in JSON:
{
  "statement": "A concise generalized belief (1 sentence, max 30 words)",
  "subject": "The entity this belief is about",
  "predicate": "The property or preference",
  "context": "When/where this applies (or 'general' if always)",
  "timeframe": "current | past | always"
}

Rules:
- Only generalize what ALL episodes support. Do not infer beyond the evidence.
- If episodes conflict, state the majority view and note the context.
- Keep the statement falsifiable — avoid vague claims.
```

### 4-Way Classification Prompt (gpt-4.1-mini)

```
Given an existing belief and a new episode, classify the relationship.

Belief: {{BELIEF_STATEMENT}}
New episode: {{EPISODE_SUMMARY}}

Classify as exactly one of:
- SUPPORTS: The episode provides evidence for this belief
- CONTRADICTS: The episode provides evidence against this belief
- PARTIAL: The episode supports the belief in some contexts but not others
- IRRELEVANT: The episode has no bearing on this belief

Respond in JSON:
{"classification": "SUPPORTS|CONTRADICTS|PARTIAL|IRRELEVANT", "reasoning": "brief explanation"}
```

### Rule-Based Gates for Destructive Ops

**Split gate** (all must be true):
1. Belief has ≥ 3 contradicting episodes AND ≥ 3 supporting episodes
2. Classification of recent contradictions returned PARTIAL at least twice
3. evidence_count ≥ 5 (don't split immature beliefs)

**Merge gate** (all must be true):
1. Two active beliefs with cosine similarity > 0.92
2. Same scope and project
3. Both have confidence > 0.6
4. Neither was recently revised (updated_at > 7 days ago)

**Archive gate** (single source of truth — called from pipeline step 5):
1. `confidence < 0.3` (regardless of evidence count or recency)
2. OR `last_reinforced_at > 90 days AND evidence_count < 5` (stale AND weak)
3. NOT manually pinned (future feature)

**Revision gate**:
1. confidence dropped below 0.4 (was previously > 0.5)
2. ≥ 3 contradicting episodes accumulated
3. evidence_count ≥ 5

---

## Retrieval Integration

### In writeRecollections (pre-computed recollection files)

After existing RRF pipeline produces top-3 episode bites:
1. Query beliefs_fts with same query text (BM25)
2. Query beliefs by vector similarity (top 10 by cosine with query embedding)
3. Score beliefs using additive weighted sum (matching handleMemoryRecall pattern): `score = 0.5 * (confidence * vectorSim) + 0.3 * retrievalStrength + 0.2 * bm25Score`
4. Filter: only `status='active'` AND `confidence > 0.4`
5. Take top-2 belief bites
6. Append to output as `[Belief (0.85): User prefers Bun for personal projects]` format
7. Update `last_accessed_at` and `access_count` for surfaced beliefs

### In handleMemoryRecall (agent-initiated)

Same blending approach:
1. Run existing episode recall pipeline
2. Additionally query beliefs (BM25 + vector)
3. Blend into results list with `type: 'belief'` tag
4. Format: `[B] (Feb 24, confidence: 0.85) User prefers Bun for personal projects — ID: bl_abc123`

### In handleMemoryExpand (for beliefs)

When ID starts with `bl_`:
1. Fetch belief by ID
2. Increment access_count, update last_accessed_at, update stability (spaced repetition)
3. Return formatted card:
   - Statement, subject, predicate, context, timeframe
   - Confidence (α/β breakdown)
   - Status, evidence count
   - Supporting episode IDs (expandable)
   - Contradicting episode IDs
   - Revision history
   - Parent/child chain

### In handleMemoryForget (for beliefs)

When ID starts with `bl_`:
1. Validate belief exists
2. Delete from beliefs table (triggers handle FTS cleanup)
3. Return confirmation

Update the existing `handleMemoryForget` ID validation to accept both `ep_*` and `bl_*` prefixes.

---

## Files to Create/Modify

| File | Type | Description |
|------|------|-------------|
| `mcp/schema.ts` | modify | Add v9 migration: beliefs table, beliefs_fts, triggers, indices |
| `processor/belief-consolidator.ts` | **create** | Core belief lifecycle: consolidation loop, clustering, synthesis, classification, reinforcement, contradiction, split, merge, revision, decay, archival |
| `processor/consolidator.ts` | modify | Call `runBeliefConsolidation()` from existing `runConsolidation()` |
| `processor/index.ts` | modify | Wire existing LLM client to consolidation (reuse OpenAI client already constructed in index.ts). Episode count check done in cold consolidation loop via checkpoint. |
| `processor/recollection-writer.ts` | modify | Query beliefs, format as belief bites, append to recollection output |
| `mcp/server.ts` | modify | Blend beliefs into handleMemoryRecall results. Handle bl_* IDs in handleMemoryExpand and handleMemoryForget. Update memory_status with belief count. Update tool descriptions for memory_recall, memory_expand, and memory_forget to reference beliefs. |

---

## Build Sequence (Task Dependencies)

```
Task 1: Schema + Types (no deps)
  - v9 migration in schema.ts
  - Belief interfaces/types
  - Confidence/decay/threshold utility functions

Task 2: Belief Consolidator (depends on 1)
  - processor/belief-consolidator.ts
  - Full consolidation pipeline: extract, cluster, synthesize, match, reinforce/contradict/create
  - Split/merge/revision with rule-based gates
  - Decay and archival

Task 3: Consolidation Wiring (depends on 2)
  - Wire into processor/consolidator.ts
  - Wire into processor/index.ts (LLM client + hot trigger)
  - Checkpoint tracking via _meta

Task 4: Retrieval Integration (depends on 1)
  - Modify recollection-writer.ts (belief bites in pre-computed files)
  - Modify mcp/server.ts (handleMemoryRecall blending, handleMemoryExpand for bl_*, memory_status)

Task 5: Testing + Calibration (depends on 2, 3, 4)
  - Manual verification of full pipeline
  - Threshold calibration (clustering similarity, confidence gates)
  - Edge case testing (empty beliefs, first consolidation, contradiction storms)
```

Tasks 1 is independent. Tasks 2 and 4 can run in parallel after 1. Task 3 depends on 2. Task 5 depends on all.

---

## Testing Strategy

### Manual Verification Checklist
1. [ ] `bun run eval/run.ts --help` still works (no regressions)
2. [ ] Schema v9 migration runs cleanly on existing DB
3. [ ] Consolidation produces beliefs from episode clusters
4. [ ] Belief statement + structured fields are coherent
5. [ ] Confidence increments on supporting evidence
6. [ ] Confidence decrements on contradicting evidence
7. [ ] Belief revision triggers when confidence drops below 0.4
8. [ ] Split triggers with rule-based gate (3+ contradictions with PARTIAL)
9. [ ] Merge triggers for high-similarity same-scope beliefs
10. [ ] Archival triggers for low-confidence or stale beliefs
11. [ ] Belief bites appear in recollection output alongside memory bites
12. [ ] memory_recall returns blended episodes + beliefs
13. [ ] memory_expand works for bl_* IDs with full card
14. [ ] memory_status shows belief count
15. [ ] Retrieval strength decay works (old unaccessed beliefs deprioritized)
16. [ ] Spaced repetition bonus increases stability on access
17. [ ] Project-scoped beliefs stay within their project
18. [ ] Global beliefs surface across all projects

### Edge Cases
- First consolidation ever (no existing beliefs)
- Episode with no matching belief cluster (singleton — should NOT create belief)
- Contradiction storm (10 contradictions in a row — should not over-revise)
- Belief about itself (meta-belief — should be treated normally)
- Empty DB (no episodes — consolidation should no-op gracefully)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM over-generalizes beliefs | High | Medium | Require 3+ episodes per cluster. Strict synthesis prompt. Structured fields as canonical state. |
| False contradictions cause belief churn | Medium | High | Rule-based gates. Destabilization threshold (old beliefs resist change). 4-way classification (PARTIAL prevents false binary). |
| Consolidation too slow (LLM calls) | Low | Medium | Batch processing. Mini model is fast. Only process new episodes since checkpoint. |
| Belief drift from compounding errors | Medium | High | Beliefs are materialized views — rebuildable from episodes. Cap revision depth. |
| Negation bugs ("don't like X" → supports X) | Medium | Medium | Use mini (not nano) for classification. Include explicit negation examples in prompt. |
| Schema migration breaks existing DB | Low | Critical | BEGIN EXCLUSIVE transaction. Belief table is additive (no existing table changes). Test on copy first. |

### Rollback Plan
- Beliefs table is entirely additive — dropping it restores previous behavior
- No existing tables are modified
- Feature can be disabled by skipping belief consolidation call in consolidator.ts
- Recall blending can be toggled via a constant (BELIEFS_ENABLED = false)

---

## Configuration Constants

```typescript
// Consolidation triggers
const BELIEF_CONSOLIDATION_EPISODE_THRESHOLD = 20;  // consolidate every N new episodes
const MIN_CLUSTER_SIZE = 3;                          // minimum episodes to form a belief
const CLUSTER_SIMILARITY_THRESHOLD = 0.70;           // cosine sim for clustering

// Belief matching
const BELIEF_REINFORCE_THRESHOLD = 0.92;  // cosine sim to consider "same belief"
const BELIEF_RELATED_THRESHOLD = 0.70;    // cosine sim to consider "related" (check contradiction)

// Confidence gates
const MIN_CONFIDENCE_FOR_RECALL = 0.4;    // below this, don't surface in recall
const REVISION_CONFIDENCE_THRESHOLD = 0.4; // below this, trigger revision
const ARCHIVE_CONFIDENCE_THRESHOLD = 0.3;  // below this, archive

// Rule-based gates
const SPLIT_MIN_CONTRADICTIONS = 3;
const SPLIT_MIN_SUPPORTS = 3;
const SPLIT_MIN_PARTIAL_COUNT = 2;
const SPLIT_MIN_EVIDENCE = 5;
const MERGE_MIN_SIMILARITY = 0.92;
const MERGE_MIN_CONFIDENCE = 0.6;
const MERGE_COOLDOWN_DAYS = 7;

// Decay
const ARCHIVE_STALE_DAYS = 90;
const ARCHIVE_MIN_EVIDENCE = 5;  // don't archive if well-evidenced

// Retrieval
const MAX_BELIEF_BITES = 2;      // max belief bites per recall
const BELIEF_SCORE_WEIGHT = 0.8; // weight for beliefs in blended recall

// LLM
const SYNTHESIS_MODEL = 'gpt-4.1-mini';
const CLASSIFICATION_MODEL = 'gpt-4.1-mini';
```

---

## Neuroscience Grounding Summary

| Neuroscience Concept | Software Implementation |
|---------------------|------------------------|
| Complementary Learning Systems (CLS) | Episodes table (hippocampus) + Beliefs table (neocortex) |
| Systems consolidation / sleep replay | Batch consolidation loop (every N episodes or 4h) |
| Prediction error triggers reconsolidation | 4-way classification detects CONTRADICTS/PARTIAL |
| Bayesian precision weighting | Beta-Bernoulli confidence (α, β) with natural resistance to change |
| Bjork's dual-strength model | evidence_count (storage) + last_accessed_at/stability (retrieval) |
| Ebbinghaus forgetting curve | Exponential retrieval decay: R(t) = e^(-t/S) |
| Spaced repetition | Stability increases with spaced retrievals |
| Schema formation | Clustering episodes → extracting generalizations |
| Schema-consistent assimilation | SUPPORTS → reinforce (increment α) |
| Reconsolidation boundary conditions | destabilizationThreshold based on age + evidence count |
| Selective consolidation (Go-CLS) | MIN_CLUSTER_SIZE=3, rule-based gates, structured prompts |
