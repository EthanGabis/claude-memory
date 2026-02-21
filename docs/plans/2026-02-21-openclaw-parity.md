# Implementation Plan: OpenClaw Memory Parity

**Date:** 2026-02-21
**Status:** Awaiting approval
**Research:** docs/research/2026-02-21-openclaw-memory-comparison.md

---

## Feature Summary

**Idea:** Bring claude-memory to 1-to-1 parity with OpenClaw's memory system by closing 5 architectural gaps.

**Chosen approach:** Option B — True 1:1 OpenClaw match using `chokidar` for file watching and `node-llama-cpp` for local GGUF embeddings with OpenAI fallback chain.

**Gaps being closed:**
1. Local GGUF embeddings as default (node-llama-cpp), OpenAI as fallback
2. Chunk embeddings computed at index time (not lazily on BM25 hits)
3. MMR (Maximal Marginal Relevance) re-ranking for result diversity
4. File watcher (chokidar) for auto-indexing any file written outside `memory_save`
5. `memory_get` MCP tool for targeted file reads by path + line range

---

## Architecture Decisions

### A. Embedding Provider Abstraction

Introduce an `EmbeddingProvider` interface with two concrete implementations:
- `LocalGGUFProvider` — lazy-loads `nomic-embed-text-v1.5.Q4_K_M.gguf` via `node-llama-cpp`
- `OpenAIProvider` — existing `text-embedding-3-small` implementation (moved from embeddings.ts)

A `FallbackChain` wraps them in order: local → OpenAI → BM25-only (null embeddings).

**Critical: dynamic import for node-llama-cpp.** `LocalGGUFProvider` must use a lazy dynamic `import('node-llama-cpp')` inside its `embed()` method — NOT a top-level static import. This is because `node-llama-cpp` native binaries may not be present under Bun's install lifecycle. A top-level static import crashes the process before any try/catch can intercept it. Dynamic import allows the `FallbackChain` to catch the error and fall through to OpenAI.

**Setup requirement:** After `bun install`, run `bunx node-llama-cpp` once to trigger native binary selection. Document this in README.

**Embedding dimensions — standardised at 768 for both providers:**
- `nomic-embed-text-v1.5` outputs 768 dims natively
- `text-embedding-3-small` configured with `dimensions: 768` (OpenAI supports Matryoshka truncation)

This is mandatory. Without dimension standardisation, cosine similarity between a 768-dim query and a 1536-dim stored chunk silently produces wrong scores (JS loop uses `va.length`, ignoring half of `vb`).

Model stored at: `~/.claude-memory/models/nomic-embed-text-v1.5.Q4_K_M.gguf` (~270MB).

**OPENAI_API_KEY startup guard softened:** The current `process.exit(1)` if no API key is present must become a warning log. After this change, the local GGUF provider makes the API key optional. Hard-exiting prevents BM25-only and local-only modes.

### B. Chunk Embeddings at Index Time

`indexFile()` accepts an optional `provider: EmbeddingProvider | null` param (default: `null` for backward-compat). When provider is non-null, embeds all chunks immediately after inserting them into the DB.

`indexDirectory()` updated to pass provider through to `indexFile()`.

**Local GGUF batching:** For `LocalGGUFProvider`, call `getEmbeddingFor()` one text at a time (node-llama-cpp's EmbeddingContext API). The `embed(texts[])` interface abstracts this — the batch abstraction is for the interface, not the local implementation.

**Startup backfill (async, non-blocking):** After server connects, schedule a background pass:
```typescript
async function backfillEmbeddings(db, provider) {
  const paths = db.prepare(
    "SELECT DISTINCT path FROM chunks WHERE embedding IS NULL"
  ).all() as { path: string }[];
  for (const { path } of paths) {
    await indexFile(db, path, ...detectLayerFromPath(path), provider);
    await new Promise(r => setTimeout(r, 0)); // yield between files
  }
}
```
`setTimeout(r, 0)` between each file yields the event loop. `fs.readFile` (async) used instead of `readFileSync` throughout `indexFile()` as part of this change.

### C. MMR Re-ranking

Applied after temporal decay scoring, before returning final results. Lambda = 0.7 (OpenClaw default).

```
Selected = []
Remaining = candidates sorted by score descending
While Remaining is not empty and Selected.length < limit:
  best = candidate in Remaining with max(0.7 × score − 0.3 × maxJaccard(candidate, Selected))
  append best to Selected
  remove best from Remaining
Return Selected
```

Jaccard similarity on `/\W+/`-split tokens (stopwords not filtered — simple implementation matching OpenClaw's approach, can be improved later).

### D. File Watcher

`chokidar` **v3.x** (not v4) — v4 is ESM-only and has unresolved issues with `fsevents` optional dep under Bun on macOS. Use `"chokidar": "^3.6.0"` which is well-tested on Bun and remains actively maintained.

Watched paths:
- `~/.claude-memory/MEMORY.md`
- `~/.claude-memory/memory/` (recursive)
- All discovered project `.claude/memory/` dirs

**Project dir discovery** uses env var `CLAUDE_MEMORY_PROJECT_ROOTS` (default: `~/Desktop/Projects`) — configurable, not hardcoded. Walks each root for `.claude/memory/` subdirs at startup.

**Self-loop dedup:** `memory_save` already calls `indexFile()` synchronously. When the watcher fires on the same file 1.5s later, it must not trigger a redundant re-index. Solution: maintain a `recentlySaved = new Set<string>()` in server.ts. `memory_save` adds the path on write; watcher checks the Set and skips if path is present; path is removed from Set after 3s via `setTimeout`.

Config: `awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 }`.

### E. `memory_get` Tool

New MCP tool. Security: path validation uses `path.resolve()` and checks `resolvedPath.startsWith(allowedRoot + path.sep)` (trailing separator prevents prefix collision like `.claude-memory-evil/`). Allowed roots frozen at startup.

```typescript
{ path: string, startLine?: number, lineCount?: number }
→ { text: string, path: string, truncated: boolean }
```

- `path` is workspace-relative (e.g., `"MEMORY.md"` or `"memory/2026-02-21.md"`)
- Resolved against `~/.claude-memory/` first; if not found there, against project memory dir
- Returns `{ text: "", path, truncated: false }` on ENOENT — no throw
- `truncated: true` when content exceeds 10K chars (so caller knows to use startLine/lineCount)

---

## Files to Create / Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `mcp/providers.ts` | **Create** | EmbeddingProvider interface, LocalGGUFProvider (dynamic import), OpenAIProvider, FallbackChain |
| `mcp/watcher.ts` | **Create** | chokidar v3 file watcher, project dir discovery via env var, self-loop dedup |
| `mcp/embeddings.ts` | **Modify** | Extract OpenAIProvider to providers.ts; keep `embedText()` removed (server.ts updated to use provider directly) |
| `mcp/indexer.ts` | **Modify** | Optional provider param, async fs.readFile, embed at index time, update indexDirectory signature |
| `mcp/search.ts` | **Modify** | Add MMR re-ranking step after temporal decay |
| `mcp/server.ts` | **Modify** | Soften API key guard to warning; wire provider + watcher; add memory_get handler; recentlySaved Set; backfill on startup |
| `package.json` | **Modify** | Add `chokidar ^3.6.0` and `node-llama-cpp ^3.4.0` |

---

## Data Model Changes

No schema changes. The `embedding` BLOB column already exists. The `embedding_cache` table stays for query-time caching.

**Dimension standardisation note:** All new chunk embeddings stored at 768 dims. Existing chunks with `embedding IS NULL` will be backfilled at 768 dims. Existing chunks with 1536-dim embeddings (from prior OpenAI runs without `dimensions` param) will be overwritten during backfill since the backfill re-indexes the whole file.

---

## API Changes (MCP Tools)

### New tool: `memory_get`
```typescript
{
  name: 'memory_get',
  description: 'Read a specific memory file by path. Returns text, path, and truncated flag. Returns empty text if file does not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path (e.g. "MEMORY.md" or "memory/2026-02-21.md")' },
      startLine: { type: 'number', description: 'Optional 1-based start line' },
      lineCount: { type: 'number', description: 'Optional number of lines to read' },
    },
    required: ['path'],
  },
}
```

### Modified tool: `memory_search`
Same interface. Internally: results now have real vector scores; MMR applied before return.

### Modified tool: `memory_save`
Same interface. Internally: indexFile now embeds chunks; recentlySaved Set updated.

---

## Implementation Tasks

### Task 1: Provider abstraction + local GGUF
**Files:** `mcp/providers.ts` (new), `mcp/embeddings.ts` (refactor)

- Define `EmbeddingProvider` interface: `embed(texts: string[]): Promise<Float32Array[]>`
- `LocalGGUFProvider`: lazy dynamic `import('node-llama-cpp')` inside `embed()`, wrapped in try/catch; auto-downloads model to `~/.claude-memory/models/` on first call; calls `getEmbeddingFor()` per text
- `OpenAIProvider`: extract existing OpenAI logic from embeddings.ts; configure `dimensions: 768`
- `FallbackChain`: try each provider in order, catch errors, fall through; last fallback returns null (BM25-only mode)
- `embeddings.ts`: remove `embedText()` wrapper; update `embedBatch()` to be internal only; keep `cosineSimilarity()` and `embedding_cache` logic in place

### Task 2: Chunk embeddings at index time
**Files:** `mcp/indexer.ts`
**Blocked by:** Task 1

- Make `indexFile()` async (use `fs.readFile` instead of `readFileSync`)
- Add `provider?: EmbeddingProvider | null` param (default null for backward-compat)
- After inserting chunks to DB, call `provider.embed(texts)` and UPDATE embedding column
- Update `indexDirectory()` to accept and pass through provider
- Add `backfillEmbeddings(db, provider)` function: queries `embedding IS NULL` paths, re-indexes with setTimeout(0) yield between files

### Task 3: MMR re-ranking
**Files:** `mcp/search.ts`
**Independent** — Wave 1, parallel with Task 1

- Add `mmrRerank(results: SearchResult[], limit: number, lambda = 0.7): SearchResult[]` function
- Jaccard helper: `jaccardSim(a: string, b: string): number` using Set intersection/union on `/\W+/` split
- Call `mmrRerank()` as final step in `search()` before returning
- MMR operates on `result.text` for similarity comparison

### Task 4: File watcher
**Files:** `mcp/watcher.ts` (new), `mcp/server.ts`
**Blocked by:** Task 1 (needs provider instance)

- `watcher.ts`:
  - `discoverProjectMemoryDirs(roots: string[]): string[]` — walks each root for `.claude/memory/`
  - `startWatcher(db, provider, globalMemoryDir, projectDirs, recentlySaved)`: chokidar v3 watch, `awaitWriteFinish: {stabilityThreshold:1500}`, on add/change: skip if path in recentlySaved, else call `indexFile()`
- `server.ts`:
  - Read `CLAUDE_MEMORY_PROJECT_ROOTS` env var (default `~/Desktop/Projects`)
  - After DB init: discover project dirs, start watcher
  - Export `recentlySaved` Set; update `saveToLog`/`saveToMemory` to add path + schedule removal after 3s

### Task 5: `memory_get` tool
**Files:** `mcp/server.ts`
**Independent** — Wave 1, parallel with Task 1

- Build `ALLOWED_ROOTS` frozen array at startup: `[globalMemoryDir, ...projectMemoryDirs]`
- `resolveMemoryPath(userPath, allowedRoots)`: `path.resolve(root, userPath)`, verify `startsWith(root + sep)`, throw if outside all roots
- `handleMemoryGet(args)`: resolve path, read file (ENOENT → `{text:"", path, truncated:false}`), slice lines if startLine given, cap at 10K chars, set `truncated` flag
- Register in ListTools + CallTool handlers

---

## Parallel Execution Waves

```
Wave 1 (3 agents in parallel):
  ├── Task 1: providers.ts + embeddings.ts refactor
  ├── Task 3: MMR re-ranking in search.ts
  └── Task 5: memory_get in server.ts

Wave 2 (2 agents in parallel, after Wave 1):
  ├── Task 2: indexer.ts (needs Task 1 provider)
  └── Task 4: watcher.ts + server.ts wiring (needs Task 1 provider)
```

---

## Dependencies to Add

```json
{
  "chokidar": "^3.6.0",
  "node-llama-cpp": "^3.4.0"
}
```

Post-install step (document in README): `bunx node-llama-cpp` to trigger native binary selection.

---

## Testing Strategy

1. **Provider fallback chain:** Unset `OPENAI_API_KEY` → verify local GGUF loads. Corrupt model file → verify falls back to OpenAI. Unset both → verify BM25-only (results still returned, vector scores = 0).
2. **Dimension check:** After indexing, `SELECT DISTINCT length(embedding)/4 FROM chunks WHERE embedding IS NOT NULL` → should return only `768`.
3. **Chunk embeddings:** After re-indexing a file, `SELECT COUNT(*) FROM chunks WHERE embedding IS NULL AND path = ?` → should be 0.
4. **MMR diversity:** Search for a repeated topic → verify top results cover different aspects rather than near-duplicates.
5. **Watcher:** `echo "## test\nfoo bar baz" >> ~/.claude-memory/memory/$(date +%Y-%m-%d).md` → wait 2s → `memory_search("foo bar baz")` → should return the new entry.
6. **Self-loop dedup:** Call `memory_save`, confirm watcher does NOT fire a second `indexFile` for the same path.
7. **memory_get valid:** Valid path returns content + `truncated: false`.
8. **memory_get ENOENT:** Non-existent path returns `{text:"", truncated:false}`, no error.
9. **memory_get traversal:** Path `"../../etc/passwd"` returns security error, not file content.
10. **memory_get truncation:** File > 10K chars returns `truncated: true`.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `node-llama-cpp` native binary missing under Bun | Medium | High | Dynamic import + FallbackChain catches; falls back to OpenAI |
| Model download fails / partial download | Medium | Medium | node-llama-cpp detects corrupt file at load; FallbackChain catches; retry next session |
| chokidar v3 + Bun compatibility | Low | High | v3 is CJS-compatible, well-tested on Bun; fallback: watcher simply doesn't start, files indexed via memory_save |
| Backfill blocks event loop | Low | Medium | setTimeout(0) yield between files; async fs.readFile |
| Dim mismatch (old 1536-dim chunks) | Low | Medium | Backfill overwrites; `cosineSimilarity` returns 0 if dims mismatch (explicit length check added) |
| Path traversal in memory_get | Low | High | `path.resolve` + `startsWith(root + sep)` check on frozen allowed roots array |
| Watcher self-loop double-index | Medium | Low | recentlySaved Set with 3s TTL suppresses duplicate watcher events |

---

## Rollback Plan

All changes are independently revertible:
- `providers.ts` / `watcher.ts` — new files, just delete
- `embeddings.ts` — no callers of removed `embedText()` remain; revert by restoring old file
- `indexer.ts` — provider param is optional with null default; rollback = pass null everywhere
- `search.ts` — MMR is final post-processing step; remove function call to revert
- `server.ts` — revert startup guard, remove watcher call, remove memory_get handler
- No schema migrations, no data loss, no format changes
