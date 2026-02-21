# Research: OpenClaw Memory System vs claude-memory

**Date:** 2026-02-21
**Question:** How does OpenClaw's memory system work, and what gaps exist in our claude-memory MCP server?

---

## OpenClaw Memory Architecture

### Two-Tier Storage (same as ours)
- `MEMORY.md` — curated, evergreen, never decays, injected into system prompt at session start
- `memory/YYYY-MM-DD.md` — append-only daily logs, subject to temporal decay

### Hybrid Search (BM25 + Vector, same weights as ours)
- Vector 70% + BM25 30%
- BM25 normalization: **rank-based** `1 / (1 + max(0, bm25Rank))` — more robust than min-max
- Union candidates from both sources by chunk ID, then merge scores

### Temporal Decay (identical formula)
- `score × e^(-λ × ageInDays)`, λ = ln(2)/30 (30-day half-life)
- MEMORY.md and non-dated files: decay = 1.0 (exempt)

### MMR Re-ranking (we are MISSING this)
- Maximal Marginal Relevance: `λ × relevance − (1−λ) × max_similarity_to_selected`
- Prevents redundant near-duplicate snippets in results
- Similarity via Jaccard tokenized text comparison
- Default lambda: 0.7

### Chunk Embeddings at Index Time (we are MISSING this)
- OpenClaw pre-embeds ALL chunks during indexing
- We store `embedding = NULL` and only compute for BM25 candidates
- Our vector search is reranking only — semantic-only queries return 0 results

### File Watcher / Auto-indexing (we are MISSING this)
- Watches `MEMORY.md` + `memory/` with 1.5s debounce
- Re-indexes any changed file automatically, async (never blocks search)
- Results may be slightly stale but never fully outdated
- This is why our system misses files written outside of `memory_save`

### `memory_get` Tool (we are MISSING this)
- Targeted read of a specific memory file by path + optional line range
- Returns `{ text, path }` — empty text if file doesn't exist (no ENOENT throw)
- Paths outside `MEMORY.md` / `memory/` are rejected for security

### Pre-compaction Flush (we have equivalent)
- Silent agentic turn triggered when context approaches limit
- Prompts model to write lasting notes to today's daily log
- Reply must be `NO_REPLY` if nothing to store (stays invisible to user)
- Tracked per session to avoid double-firing

### Session-Start Context Injection (we have equivalent, slightly different)
- Injects: MEMORY.md + today's log + yesterday's log
- We inject: MEMORY.md + last 3 daily logs (more generous, not targeted to yesterday specifically)

### Local Embeddings (we don't have, but optional)
- Default: auto-downloads GGUF model (~0.6GB) via node-llama-cpp
- Fallback chain: local → openai → gemini → voyage
- We only support OpenAI

---

## Gap Analysis

| Feature | OpenClaw | claude-memory | Priority |
|---------|----------|---------------|----------|
| Two-tier MEMORY.md + daily logs | ✅ | ✅ | — |
| Hybrid BM25 + vector (70/30) | ✅ | ✅ | — |
| Temporal decay (30-day half-life) | ✅ | ✅ | — |
| MEMORY.md evergreen (no decay) | ✅ | ✅ | — |
| Pre-compaction flush | ✅ | ✅ | — |
| Session-start context injection | ✅ | ✅ | — |
| Embedding cache | ✅ | ✅ | — |
| FTS5 + SQLite | ✅ | ✅ | — |
| 400-token chunks, 80-token overlap | ✅ | ✅ | — |
| **MMR re-ranking** | ✅ | ❌ | HIGH |
| **Chunk embeddings at index time** | ✅ | ❌ | HIGH |
| **File watcher / auto-indexing** | ✅ | ❌ | HIGH |
| **`memory_get` tool** | ✅ | ❌ | MEDIUM |
| **Rank-based BM25 normalization** | ✅ | ❌ (min-max) | LOW |
| Local embeddings (GGUF) | ✅ | ❌ | OPTIONAL |

---

## Key Insights

1. **File watcher is the most impactful gap.** Files written via Write tool, bash, or migration scripts are never indexed. Search silently misses them until a memory_save call re-indexes.

2. **Chunk embeddings at index time enables true hybrid search.** Right now, vector search only reranks BM25 candidates. A semantically relevant chunk with no BM25 term overlap is invisible.

3. **MMR prevents the "all results look the same" problem.** Without it, a search returns 10 slightly different phrasings of the same fact.

4. **memory_get is a useful escape hatch.** Lets the model read a specific known file directly without going through search (e.g., "read MEMORY.md lines 50-100").

5. **OpenClaw never throws on missing files.** Returns empty content — prevents agent errors when memory files don't exist yet.

## Open Questions

- Do we want local GGUF embeddings to avoid OpenAI dependency/cost?
- Should session-start inject yesterday specifically (OpenClaw) vs last N logs (our approach)?
- How to handle the backfill: indexing chunk embeddings for the 5224 existing chunks?
