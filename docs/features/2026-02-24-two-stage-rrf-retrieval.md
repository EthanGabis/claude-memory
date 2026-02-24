# Two-Stage RRF Retrieval

**Date:** 2026-02-24
**Status:** Implemented
**Plan:** docs/plans/2026-02-24-two-stage-rrf-retrieval.md
**R&D:** docs/rnd/2026-02-24-two-stage-retrieval.md

## Overview

Replaced the weighted scoring formula in the memory recollection system with Reciprocal Rank Fusion (RRF), and expanded the candidate pool to include BM25 keyword hits beyond the 200 most-recently-accessed episodes.

## How It Works

1. User sends a prompt, triggering the recollection pipeline
2. BM25 full-text search runs against ALL episodes (up to 50 hits)
3. Vector pool fetches the 200 most-recently-accessed episodes with embeddings
4. BM25 hits NOT in the vector pool are fetched separately and merged into the candidate set
5. Pre-compute pass: cosine similarity calculated once per candidate (O(N))
6. 4 rank lists built with dense ranking (ties share same rank):
   - BM25: ascending FTS5 score (more negative = better match)
   - Vector: descending cosine similarity
   - Recency: descending created_at
   - Access frequency: descending access_count
7. RRF fusion: score = W_BM25/(K+bm25Rank) + W_VECTOR/(K+vecRank) + W_RECENCY/(K+recencyRank) + W_ACCESS/(K+accessRank)
   - K=60, W_BM25=1.0, W_VECTOR=1.0, W_RECENCY=0.6, W_ACCESS=0.4
   - BM25 absent candidates contribute 0 (not worst-rank)
   - High-importance episodes get additive boost: 1/(K+1) - 1/(K+11)
8. Top 3 episodes selected, written to recollection file

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| processor/recollection-writer.ts | Modified | Replaced weighted scoring (lines 148-215) with RRF: pool expansion, pre-compute pass, 4 rank lists, RRF fusion |
| mcp/schema.ts | Modified | Added v8 migration: partial index on episodes(accessed_at DESC) WHERE embedding IS NOT NULL |

## Architecture Decisions

1. **RRF over weighted scores**: Eliminates fragile min-max BM25 normalization. Rank-based fusion doesn't require score normalization between BM25 and cosine similarity. Industry standard (Azure AI Search, OpenSearch, Weaviate).
2. **4-list weighted RRF**: Preserves temporal and frequency signals as additional rank lists instead of post-hoc multipliers. Weights (1.0/1.0/0.6/0.4) keep relevance dominant.
3. **Pool expansion via BM25 misses**: Old keyword-relevant episodes now enter the scoring pool even if outside the 200 most-recent window. Typically adds 5-20 candidates.
4. **Partial index**: Tailored to the exact vector pool query (accessed_at DESC WHERE embedding IS NOT NULL) for optimal index scan.
5. **Dense ranking**: Ties share the same rank, ensuring deterministic scoring for episodes with equal values.

## Known Limitations

- Float equality for tie detection could miss near-ties in cosine similarity
- K=60 is conservative for 200-250 candidates (lower K would be more decisive)
- Result ordering changed from previous formula — may surface different memories than before

## Testing Notes

- Verify memories appear on prompt (UserPromptSubmit hook)
- Create an old episode with specific keywords, verify it surfaces when those keywords are typed (tests pool expansion)
- High-importance episodes should rank higher than equal-relevance normal episodes
- Restart daemon to trigger v8 migration — verify index is created
- Performance: /recollect should stay under 240ms
