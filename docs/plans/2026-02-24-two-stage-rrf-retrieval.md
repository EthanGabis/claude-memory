# R&D Plan: Two-Stage RRF Retrieval

**Date:** 2026-02-24
**Status:** Reviewed
**Area:** Data layer
**Scope:** Medium

## Feature Summary

**Idea:** Replace the weighted scoring formula in recollection-writer.ts with Reciprocal Rank Fusion (RRF) across four ranked lists: BM25, vector similarity, recency, and access frequency — while expanding the candidate pool to include BM25 hits beyond the 200-episode vector window.
**Problem:** The 200-episode LIMIT on vector candidates silently drops old memories. The current scoring formula mixes raw scores with min-max normalization, which is fragile and loses BM25 hits outside the window.
**User:** Any Claude Code user with >200 episodes across projects.
**How Might We:** "How might we ensure keyword-relevant memories surface regardless of age or access recency?"

## Chosen Approach

**Option selected:** Full RRF Replacement (Option C)
**Rationale:** RRF is the industry standard for hybrid retrieval (Azure AI Search, OpenSearch, Weaviate). It eliminates the need for score normalization between BM25 and cosine similarity, naturally handles the union of different candidate sources, and extends cleanly to additional signals (recency, access frequency) as additional rank lists. The current min-max BM25 normalization is fragile (single hits get a hardcoded 0.5, inverted scale is confusing).

### Alternatives Considered

| Option | Approach | Why Not |
|--------|----------|---------|
| Option A: Simple Pool Expansion | Fetch BM25 misses, add to 200 pool, keep existing formula | Preserves the fragile min-max normalization; doesn't fix the scoring design |
| Option B: Pool Expansion + Index | Same as A + accessed_at index | Same scoring issues as A |

## Research Findings

### Codebase Analysis

**The gap (recollection-writer.ts:150-156):**
- BM25 searches ALL episodes via FTS5 (up to 50 hits)
- Vector pool fetches only 200 most-recently-accessed episodes
- Scoring loop only iterates the 200 vector candidates
- BM25 hits at position 201+ in `accessed_at DESC` ordering are silently lost
- No index on `accessed_at` — full table scan on every recollection

**Current scoring formula (lines 164-214):**
- `relevance = 0.7 * vectorSim + 0.3 * normBm25`
- `normBm25` uses min-max normalization with inverted BM25 scale
- High-importance floor: `relevance = max(relevance, 0.3)` if importance='high'
- `recency = exp(-ln2/30 * ageDays)` — 30-day half-life
- `accessFreq = (count + 1) / (maxCount + 1)` — Laplace-smoothed
- `finalScore = 0.5 * relevance + 0.3 * recency + 0.2 * accessFreq`

### Best Practices

**Reciprocal Rank Fusion (RRF):**
- Formula: `score(d) = Σ 1/(k + rank_i(d))` across all ranked lists
- Standard k=60 (dampens impact of high-rank outliers)
- Rank-based: no score normalization needed between BM25 and cosine similarity
- Used by Azure AI Search, OpenSearch, Weaviate in production
- Extends naturally to N ranked lists (add recency rank, frequency rank)
- Reference: Alex Garcia's sqlite-vec hybrid search blog

**Multi-list weighted RRF:**
- `score(d) = w1/(k + bm25_rank) + w2/(k + vec_rank) + w3/(k + recency_rank) + w4/(k + freq_rank)`
- Weights allow tuning relative importance of each signal
- Standard: w1=w2=w3=w4=1.0 (equal weighting), but customizable

## Architecture

### Overview

Replace the monolithic scoring formula with multi-list RRF:

1. **BM25 ranked list** — from FTS5 MATCH, scans all episodes (existing)
2. **Vector ranked list** — cosine similarity against expanded candidate pool
3. **Recency ranked list** — rank by `created_at DESC`
4. **Access frequency ranked list** — rank by `access_count DESC`
5. **RRF fusion** — weighted sum of `1/(k + rank)` across all lists
6. **High-importance boost** — high-importance episodes get a rank bonus

### Data Flow

```
User prompt
  → embed (existing)
  → topic gate (existing)
  → BM25 search: top 50 from episodes_fts (existing, all episodes)
  → Vector pool: 200 most recent episodes (existing)
  → NEW: Fetch BM25 misses — episodes in bm25Map but NOT in vector pool
  → NEW: Merge into unified candidate set (dedup by rowid)
  → NEW: Build 4 ranked lists from unified candidates
  → NEW: RRF fusion: weighted sum of 1/(k + rank) per list
  → NEW: High-importance bonus (additive rank boost)
  → Top 3 by RRF score
  → Write recollection file (existing)
```

## Implementation Plan

### Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `processor/recollection-writer.ts` | Replace scoring with RRF; add BM25 miss fetch; expand candidate pool | 1 |
| `mcp/schema.ts` | Add v8 migration: `CREATE INDEX idx_episodes_accessed_at ON episodes(accessed_at)` | 2 |

### Files to Create

None.

### Data Model Changes

| Table | Change |
|-------|--------|
| `episodes` | Add partial index: `idx_episodes_accessed_at ON episodes(accessed_at DESC) WHERE embedding IS NOT NULL` |

### Build Sequence

Implement in this order:

**Task 1: Schema migration (schema.ts)**
- Add v8 migration following existing pattern (BEGIN EXCLUSIVE, CREATE INDEX IF NOT EXISTS, UPDATE _meta, COMMIT)
- Partial index tailored to the vector pool query: `CREATE INDEX IF NOT EXISTS idx_episodes_accessed_at ON episodes(accessed_at DESC) WHERE embedding IS NOT NULL`
- Handle duplicate index (already exists) in catch block

**Task 2: RRF scoring rewrite (recollection-writer.ts)**

This is the core change. Replace lines 148-215 with:

**Step 2a: Expand candidate pool**
```
After building bm25Map:
1. Keep existing vector pool query (LIMIT 200, ORDER BY accessed_at DESC)
2. Collect the rowids from the vector pool into a Set<number>
3. Find BM25 rowids NOT in the vector pool Set:
   const missingRowids = [...bm25Map.keys()].filter(rid => !vectorPoolRowids.has(rid));
4. If missingRowids.length > 0, fetch those missing episodes with dynamic placeholders:
   const placeholders = missingRowids.map(() => '?').join(',');
   db.prepare(`SELECT ... FROM episodes WHERE rowid IN (${placeholders}) AND embedding IS NOT NULL`).all(...missingRowids)
   NOTE: Never pass array as single ?; never construct IN () with zero items (skip query if empty).
5. Merge into a single candidates array: [...vectorPoolEpisodes, ...bm25Misses]
```

**Step 2b: Pre-compute scores and build ranked lists**
```
IMPORTANT: Pre-compute all per-episode values in a single O(N) pass BEFORE building rank lists.
This avoids calling cosineSimilarity inside sort comparators (which costs O(N log N) calls).

Pre-compute pass (O(N) — one call per episode):
  For each candidate:
    vectorSim = cosineSimilarity(queryBlob, episode.embedding as Buffer)
    // Null guard: if episode.embedding is somehow null despite WHERE filter, set vectorSim = 0
    bm25Score = bm25Map.get(episode.rowid) ?? null  // null = no BM25 hit

  Store in a Map<rowid, { vectorSim, bm25Score }> or parallel array.

Build rank lists (4 stable sorts on pre-computed values):
1. BM25 rank list: sort candidates with BM25 hits by bm25Score ascending (more negative = better)
   - Candidates NOT in bm25Map: contribute 0 to BM25 RRF term (skip, don't assign worst-rank)
   - If bm25Map is empty (no FTS hits at all): skip BM25 term entirely for all candidates
2. Vector rank list: sort ALL candidates by pre-computed vectorSim descending
   - Rank 1 = highest similarity
3. Recency rank list: sort ALL candidates by created_at descending
   - Rank 1 = most recent
4. Access frequency rank list: sort ALL candidates by access_count descending
   - Rank 1 = most accessed

Rank assignment: 1-based. Ties get the same rank (dense ranking).
```

**Step 2c: RRF fusion**
```
Constants:
  K = 60 (standard RRF parameter — Cormack et al. 2009)
  W_BM25 = 1.0    // keyword relevance
  W_VECTOR = 1.0   // semantic relevance
  W_RECENCY = 0.6  // temporal signal
  W_ACCESS = 0.4   // usage frequency signal

  NOTE: RRF weights are relative multipliers, NOT a probability distribution.
  They do not need to sum to 1. Higher = more influence on final ranking.

For each candidate:
  rrfScore = 0

  // BM25 contribution: only if this candidate has a BM25 hit AND bm25Map is non-empty
  if (bm25Rank !== null):
    rrfScore += W_BM25 / (K + bm25Rank)

  // Vector, recency, access: always contribute (every candidate has these)
  rrfScore += W_VECTOR / (K + vectorRank)
           + W_RECENCY / (K + recencyRank)
           + W_ACCESS / (K + accessRank)

  // High-importance boost: additive bonus equivalent to ~10 rank positions
  // Uses K variable so boost scales if K is ever tuned
  if (importance === 'high'):
    rrfScore += 1.0 / (K + 1) - 1.0 / (K + 11)  // ~0.0023 at K=60
```

**Step 2d: Select top 3, write file, update accessed_at** (same as existing)

### Weight Rationale

- `W_BM25 = 1.0, W_VECTOR = 1.0`: Equal weight for keyword and semantic relevance — the two primary relevance signals
- `W_RECENCY = 0.6`: Recency matters but shouldn't dominate — a 90-day-old memory about the exact topic should still surface
- `W_ACCESS = 0.4`: Lowest weight — access frequency is a weak signal, more of a tiebreaker
- `K = 60`: Standard RRF parameter — dampens the impact of being rank 1 vs rank 2

These weights preserve the current system's intent (relevance-heavy with recency/frequency as secondary signals) while being cleaner than the old `0.5/0.3/0.2` with nested `0.7/0.3`.

## Testing Strategy

### Manual Verification
- [ ] With <200 episodes: behavior should be identical (all episodes in both pools)
- [ ] With >200 episodes: create an old episode with specific keywords, verify it surfaces when those keywords are typed
- [ ] High-importance episodes: verify they get boosted in results
- [ ] Performance: /recollect should stay within 240ms budget
- [ ] Restart daemon — verify v8 migration runs cleanly (index created)
- [ ] Run daemon twice — verify v8 migration handles "already exists" gracefully

## Risk Assessment

### Blast Radius
Only `recollection-writer.ts` scoring logic changes. The function signature, return type, and file output format are unchanged. No other files call the scoring internals.

### Regression Risk
- Result ordering will change (different scoring formula) — memories that surfaced before may not surface now, and vice versa. This is intentional but should be monitored.
- The BM25 miss fetch adds extra DB reads (~5-20 rows typically). Worst case: 50 BM25 hits all outside the 200 pool = 50 extra row fetches.

### Performance Impact
- BM25 miss fetch: 1 SQL query with IN clause (~1ms for 50 rowids)
- 4 sort operations on ~200-250 episodes: ~0.1ms each
- RRF score computation: pure arithmetic, ~0.01ms per episode
- Net impact: <5ms additional — well within 240ms budget
- The new `accessed_at` index makes the existing LIMIT 200 query faster (index scan vs table scan)

### Rollback Plan
Revert `processor/recollection-writer.ts` to previous version. The v8 index migration is non-destructive and can stay.

## Review Notes

### Code Review Findings (Confidence: 7/10 → 9/10 after fixes)

**Critical — all addressed:**
- C1: IN clause binding — plan now specifies dynamic placeholder generation + empty array guard
- C2: Sort comparator trap — plan now specifies pre-compute pass in O(N) before rank sorts
- C3: High-importance boost comment — fixed to ~0.0023, formula uses K variable

**Important — addressed:**
- I4: BM25 absent handling — candidates without BM25 hits contribute 0 (not worst-rank); empty bm25Map skips BM25 term entirely
- I5: Partial index — changed to `ON episodes(accessed_at DESC) WHERE embedding IS NOT NULL` to match exact query
- I6: k=60 conservative for 200-250 candidates — acknowledged; keeping k=60 as standard, can tune later
- I7: Null guard on embedding — added to pre-compute pass description

**Minor — noted:**
- M10: Weight comment clarification — added note that RRF weights are relative multipliers, not probability distribution
- M11: Embedding failure early-return — confirmed unchanged (existing fail-fast behavior preserved)
