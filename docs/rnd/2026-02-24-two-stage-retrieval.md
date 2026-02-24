# R&D Findings: Two-Stage Retrieval

**Date:** 2026-02-24
**Feature Summary:** Merge BM25 full-text hits into the vector search candidate pool so old but keyword-relevant memories aren't silently dropped by the 200-episode LIMIT.

## Codebase Analysis

### Retrieval Pipeline (recollection-writer.ts)

1. **Embed** — truncate user message to 6000 chars, embed via local GGUF (~5-20ms)
2. **Topic gate** — cosine_sim(prev, current) > 0.85 → skip (bypassed when force=true)
3. **BM25** — `episodes_fts MATCH ? LIMIT 50` against ALL episodes → `bm25Map<rowid, score>`
4. **Vector pool** — `SELECT ... FROM episodes WHERE embedding IS NOT NULL ORDER BY accessed_at DESC LIMIT 200`
5. **Scoring** — for each of the 200 candidates:
   - `relevance = 0.7 * vectorSim + 0.3 * normBm25`
   - `finalScore = 0.5 * relevance + 0.3 * recency + 0.2 * accessFreq`
6. **Top-3** — sort by finalScore, take top 3, write to JSON file

### The Gap

BM25 can return up to 50 hits across ALL episodes. But the scoring loop only iterates over the 200 vector candidates. Any BM25 hit at position 201+ in `accessed_at DESC` ordering is silently lost — its rowid exists in `bm25Map` but never gets scored.

### Key File Locations

- `processor/recollection-writer.ts:150-156` — the LIMIT 200 query (the bottleneck)
- `processor/recollection-writer.ts:111-146` — BM25 query (searches all episodes)
- `processor/recollection-writer.ts:165-215` — scoring loop (only iterates 200 candidates)
- No index on `accessed_at` — full table scan on every recollection call

### Schema Notes

- `episodes` table has `rowid` (physical), `id` (text PK), `embedding` (BLOB), `accessed_at` (INTEGER)
- `episodes_fts` joins via `rowid` to `episodes`
- All episodes should have embeddings (indexed at creation time)

## Best Practices Research

### Recommended: Union Pool approach

Three approaches evaluated:
1. **Union + Reciprocal Rank Fusion (RRF)** — rank-based fusion, no score normalization needed
2. **Union + Weighted Score Combination** — requires min-max normalization, alpha tuning
3. **BM25 → Vector Re-rank** — two-stage with embedding fetch, loses vector-only hits

### Key Insight for Our System

RRF is the industry standard for hybrid search (used by Azure AI Search, OpenSearch, Weaviate). However, **our system already has a working scored formula** that combines BM25 + vector + recency + access frequency. Switching to RRF would replace a tuned formula with a generic one.

**The simpler, better fix:** just expand the candidate pool to include BM25 hits, then run the existing scoring formula on the expanded set. This:
- Preserves the existing scoring weights (0.7 vector + 0.3 BM25 for relevance)
- Preserves temporal decay and access frequency signals
- Only adds ~5-20 extra episodes to the scoring loop (negligible cost)
- Requires no score normalization changes

For BM25-only hits that ARE in the expanded pool: they already have stored embeddings (all indexed episodes do), so `cosineSimilarity()` works as-is. The vector signal for these old episodes might actually be strong since the user typed matching keywords.

## Key Insights

1. The fix is localized to ~15 lines in recollection-writer.ts — fetch BM25 hit rowids not in the 200 pool, add them to candidates
2. No index on `accessed_at` means the LIMIT 200 query does a full table scan — adding an index is a free perf win
3. BM25-only hits already have stored embeddings, so the full scoring formula works without modification
4. The existing scoring formula is BETTER than RRF for our use case because it includes temporal decay and access frequency

## Assumptions to Validate

- All episodes have embeddings (importance: high, evidence: high — indexed at creation)
- BM25 misses outside the 200 pool are typically 5-20 episodes, not hundreds (importance: medium, evidence: medium)
- The extra rows don't blow the 240ms performance budget (importance: high, evidence: high — cosine sim is ~0.01ms per episode)
