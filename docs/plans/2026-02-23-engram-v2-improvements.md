# Engram V2 Improvements + Full System Hardening

**Date:** 2026-02-23
**Status:** Pending Approval
**Parent:** docs/plans/2026-02-23-engram-v2.md

## Overview

Four feature improvements PLUS a comprehensive hardening pass fixing every bug found by code review and Codex audit. This plan covers 18 changes across 11 files — turning the prototype into production-grade infrastructure.

---

## Part A: System Hardening (6 Critical + 9 Important + 3 Minor)

### Task A1: File Lock Utility for MEMORY.md

**Problem:** Consolidator uses `appendFile` while MCP server uses `writeFile` (full rewrite) on the same MEMORY.md. Concurrent execution silently loses data.

**New file:** `shared/file-lock.ts`

```typescript
import fs from 'node:fs';

const LOCK_TIMEOUT = 5000;
const RETRY_INTERVAL = 50;

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create
      fs.closeSync(fd);
      break;
    } catch {
      if (Date.now() > deadline) {
        try { fs.unlinkSync(lockPath); } catch {} // stale lock
        continue;
      }
      await new Promise(r => setTimeout(r, RETRY_INTERVAL));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
```

**Modified files:**
- `processor/consolidator.ts` — wrap `graduateEpisodes` file I/O in `withFileLock(GLOBAL_MEMORY_PATH + '.lock', ...)`
- `mcp/server.ts` `saveToMemory()` — wrap read+write in `withFileLock(memoryPath + '.lock', ...)`

---

### Task A2: Consolidation Overlap Guard

**Problem:** `setInterval` async callback can re-enter if execution exceeds interval.

**Modified file:** `processor/index.ts`

Add `isConsolidating` boolean before the setInterval (same pattern as `shutdownInProgress`):

```typescript
let isConsolidating = false;
setInterval(async () => {
  if (isConsolidating) return;
  isConsolidating = true;
  try {
    const result = await runConsolidation(db);
    console.error(`[engram] Cold consolidation: ${result.graduated} graduated, ${result.compressed} compressed`);
  } catch (err) {
    console.error(`[engram] Cold consolidation failed: ${(err as Error).message}`);
  } finally {
    isConsolidating = false;
  }
}, COLD_CONSOLIDATION_INTERVAL_MS);
```

---

### Task A3: JSONL Partial Line Buffer

**Problem:** If the last line in a read chunk is incomplete JSON, it's discarded and offset advances past it — permanently losing that message.

**Modified file:** `processor/session-tailer.ts`

Add `private pendingLine = '';` field to `SessionTailer`. In `readNewLines()`:

```typescript
const text = this.pendingLine + buf.toString('utf-8');
const lines = text.split('\n');
this.pendingLine = lines.pop() ?? ''; // keep trailing incomplete line

const consumedBytes = Buffer.byteLength(text, 'utf-8') - Buffer.byteLength(this.pendingLine, 'utf-8');

for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const entry = JSON.parse(line) as JsonlEntry;
    await this.processEntry(entry);
  } catch { /* malformed line — skip */ }
}

this.stateStore.updateSession(this.sessionId, {
  byteOffset: state.byteOffset + consumedBytes,
});
```

Also add file truncation detection:
```typescript
if (stat.size < state.byteOffset) {
  console.error(`[tailer:${this.sessionId.slice(0, 8)}] File truncated — resetting`);
  this.stateStore.updateSession(this.sessionId, { byteOffset: 0 });
  this.pendingLine = '';
  return;
}
```

Also wrap fd in try/finally:
```typescript
const fd = fs.openSync(this.jsonlPath, 'r');
try {
  fs.readSync(fd, buf, 0, newSize, state.byteOffset);
} finally {
  fs.closeSync(fd);
}
```

---

### Task A4: Atomic PID File

**Problem:** check-then-write PID file is non-atomic — two daemons can start simultaneously.

**Modified file:** `processor/index.ts`

Replace `checkPidFile()` + `writePidFile()` with single `acquirePidFile()`:

```typescript
let pidFd: number | null = null; // keep open for daemon lifetime

function acquirePidFile(): boolean {
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  try {
    pidFd = fs.openSync(PID_PATH, 'wx'); // O_WRONLY | O_CREAT | O_EXCL
    fs.writeSync(pidFd, String(process.pid));
    return true;
  } catch {
    // File exists — check if process alive
    try {
      const pidStr = fs.readFileSync(PID_PATH, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          return false; // another instance running
        } catch { /* dead process */ }
      }
    } catch { /* can't read */ }
    // Stale — remove and retry
    try { fs.unlinkSync(PID_PATH); } catch {}
    return acquirePidFile();
  }
}

function removePidFile(): void {
  if (pidFd !== null) {
    try { fs.closeSync(pidFd); } catch {}
    pidFd = null;
  }
  try { fs.unlinkSync(PID_PATH); } catch {}
}
```

---

### Task A5: Watcher Ignore Fix

**Problem:** Regex `/[/\\]\./` matches `.claude` and `.claude-memory` parent directories, so MEMORY.md changes in those dirs are never picked up by the watcher.

**Modified file:** `mcp/watcher.ts` line 99

Replace:
```typescript
ignored: /[/\\]\./,
```

With:
```typescript
ignored: (filePath: string) => {
  const basename = path.basename(filePath);
  // Ignore dotfiles EXCEPT .claude and .claude-memory directories
  if (basename.startsWith('.') && basename !== '.claude' && basename !== '.claude-memory') {
    return true;
  }
  return false;
},
```

---

### Task A6: Search — Global Chunks + Vector Fallback

**Problem:** Project-filtered search drops global chunks. Also, empty FTS returns 0 results even when vector matches exist.

**Modified file:** `mcp/search.ts`

1. **Global inclusion** — change line 114-116:
```typescript
const chunkStmt = project
  ? db.prepare('SELECT * FROM chunks WHERE rowid = ? AND (project = ? OR project IS NULL)')
  : db.prepare('SELECT * FROM chunks WHERE rowid = ?');
```

2. **Vector fallback** — after `if (bm25Rows.length === 0)` at line 111, instead of returning empty, fall through to vector-only path:
```typescript
if (bm25Rows.length === 0) {
  // Vector-only fallback: scan all chunks with embeddings
  const allChunks = (project
    ? db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL AND (project = ? OR project IS NULL) LIMIT ?').all(project, candidateCount)
    : db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL LIMIT ?').all(candidateCount)
  ) as ChunkRow[];

  const vectorResults: SearchResult[] = allChunks
    .map(chunk => {
      const vectorScore = chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
      const ageInDays = (Date.now() - chunk.updated_at) / 86_400_000;
      const decay = isEvergreen(chunk.path) ? 1.0 : Math.exp(-(Math.LN2 / 30) * ageInDays);
      return {
        id: chunk.id, path: chunk.path, layer: chunk.layer, project: chunk.project,
        startLine: chunk.start_line, endLine: chunk.end_line, text: chunk.text,
        score: vectorScore * decay,
      };
    })
    .sort((a, b) => b.score - a.score);

  return mmrRerank(vectorResults, limit);
}
```

---

### Task A7: Tailer Eviction

**Problem:** Tailers for deleted/old sessions are never removed — leaks watchers and memory in 24/7 daemon.

**Modified file:** `processor/index.ts`

In the session scan interval, add eviction logic:

```typescript
setInterval(() => {
  // Evict stale tailers
  for (const [id, tailer] of tailers) {
    try {
      const stat = fs.statSync(tailer.jsonlPath);
      if (Date.now() - stat.mtimeMs > MAX_FILE_AGE_DAYS * 86_400_000) {
        console.error(`[engram] Evicting stale tailer: ${id.slice(0, 8)}`);
        tailer.stop();
        tailers.delete(id);
      }
    } catch {
      // File gone
      console.error(`[engram] Evicting missing tailer: ${id.slice(0, 8)}`);
      tailer.stop();
      tailers.delete(id);
    }
  }
  // ... existing scan + memory check
}, SESSION_SCAN_INTERVAL_MS);
```

Also expose `jsonlPath` as a public readonly field on `SessionTailer`.

---

### Task A8: Remove Cross-Session Hook Fallback

**Problem:** When no session ID is found, the hook falls back to "most recent recollection file" — could inject wrong session's memories in multi-session use.

**Modified file:** `hooks/pretooluse-recollection.ts`

Remove Strategy C entirely (lines 55-71). After Strategy B, if no session ID:
```typescript
if (!sessionId) process.exit(0);
```

---

### Task A9: Episode Snapshot Freshness

**Problem:** `fetchEpisodeSnapshot` is called once per extraction batch. Newly added episodes within the same batch aren't seen by subsequent candidates, allowing near-duplicates.

**Modified files:** `processor/session-tailer.ts` + `processor/extractor.ts`

After `upsertEpisode` returns `'add'`, push the new episode into `episodeSnapshot`:
```typescript
if (action === 'add') {
  episodeSnapshot.push({
    id: newId,
    summary: candidate.summary,
    entities: JSON.stringify(candidate.entities),
    embedding: candidateBlob,
    access_count: 0,
  });
}
```

This requires `upsertEpisode` to return the new episode ID on add. Change return type from `'add' | 'update' | 'noop'` to `{ action: 'add'; id: string } | { action: 'update' | 'noop' }`.

---

### Task A10: Input Validation

**Problem:** Limit params unvalidated; lineCount can be <= 0.

**Modified file:** `mcp/server.ts`

- `handleMemorySearch` line 263: `const effectiveLimit = Math.max(1, Math.min(limit ?? 10, 50));`
- `handleMemoryRecall` line 620: Already has `Math.min(limit, 50)` — add `Math.max(1, ...)`
- `handleMemoryGet`: Add `if (lineCount !== undefined && lineCount < 1)` validation after startLine check

---

## Part B: Four Feature Improvements

### Task B1: Cold-Path Consolidation (fix existing + add lock)

**Modified file:** `processor/consolidator.ts` (already exists from premature agent)

Fixes to apply:
1. Wrap file I/O in `withFileLock`
2. Fix dedup: check full formatted `entry.trim()` instead of raw `candidate.summary`
3. Use read-then-rewrite (matching server.ts pattern) instead of appendFile

```typescript
import { withFileLock } from '../shared/file-lock.js';

async function graduateEpisodes(db: Database): Promise<number> {
  // ... query candidates ...
  if (candidates.length === 0) return 0;

  return withFileLock(GLOBAL_MEMORY_PATH + '.lock', async () => {
    let existing = '';
    try { existing = await fs.readFile(GLOBAL_MEMORY_PATH, 'utf-8'); } catch {}

    let graduated = 0;
    let newContent = existing;

    for (const candidate of candidates) {
      if (graduated >= MAX_GRADUATED_PER_CYCLE) break;

      const date = new Date(candidate.created_at).toISOString().split('T')[0];
      const projectTag = candidate.project ? ` (project: ${candidate.project})` : '';
      const entitiesStr = candidate.entities ? ` [${candidate.entities}]` : '';
      const entry = `\n## ${date}\n${candidate.summary}${projectTag}${entitiesStr}\n`;

      // Dedup on full entry, not raw summary
      if (newContent.includes(entry.trim())) continue;

      newContent += entry;
      graduated++;
    }

    if (graduated > 0) {
      await fs.mkdir(path.dirname(GLOBAL_MEMORY_PATH), { recursive: true });
      // Atomic write: temp + rename (matching server.ts safety pattern)
      const tmpPath = GLOBAL_MEMORY_PATH + '.tmp';
      await fs.writeFile(tmpPath, newContent, 'utf-8');
      await fs.rename(tmpPath, GLOBAL_MEMORY_PATH);
    }

    return graduated;
  });
}
```

**Modified file:** `processor/index.ts` — add overlap guard (Task A2), wire consolidation.

---

### Task B2: Inspection CLI

**New file:** `scripts/inspect.ts`

Standalone read-only CLI. Reads SQLite with `{ readonly: true }`, reads engram-state.json, checks PID file. Supports `--json` flag.

Sections: daemon health, episode counts (GROUP BY project/scope/importance), active session states, last 10 extractions.

**Modified file:** `package.json` — add `"inspect": "bun scripts/inspect.ts"`

---

### Task B3: Add Entities to FTS5

**Modified file:** `mcp/schema.ts`

Schema v3 migration wrapped in `BEGIN EXCLUSIVE ... COMMIT`:

```typescript
if (v3Version < 3) {
  db.exec(`BEGIN EXCLUSIVE`);
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS episodes_ai;
      DROP TRIGGER IF EXISTS episodes_ad;
      DROP TRIGGER IF EXISTS episodes_au;
      DROP TABLE IF EXISTS episodes_fts;

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        summary, entities, content='episodes', content_rowid='rowid'
      );

      CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, summary, entities)
        VALUES (new.rowid, new.summary, COALESCE(new.entities, ''));
      END;

      CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, summary, entities)
        VALUES ('delete', old.rowid, old.summary, COALESCE(old.entities, ''));
      END;

      CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, summary, entities)
        VALUES ('delete', old.rowid, old.summary, COALESCE(old.entities, ''));
        INSERT INTO episodes_fts(rowid, summary, entities)
        VALUES (new.rowid, new.summary, COALESCE(new.entities, ''));
      END;

      INSERT INTO episodes_fts(rowid, summary, entities)
      SELECT rowid, summary, COALESCE(entities, '') FROM episodes;

      UPDATE _meta SET value = '3' WHERE key = 'schema_version';
    `);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    throw err;
  }
}
```

Zero query changes needed — FTS5 MATCH searches all columns by default.

---

### Task B4: Topic-Change Threshold

**Modified file:** `processor/recollection-writer.ts`

Add after imports:
```typescript
const DEFAULT_TOPIC_THRESHOLD = 0.85;
const TOPIC_CHANGE_THRESHOLD = (() => {
  const val = process.env.ENGRAM_TOPIC_THRESHOLD;
  if (!val) return DEFAULT_TOPIC_THRESHOLD;
  const parsed = parseFloat(val);
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.error(`[recollection] Invalid ENGRAM_TOPIC_THRESHOLD="${val}" — using ${DEFAULT_TOPIC_THRESHOLD}`);
    return DEFAULT_TOPIC_THRESHOLD;
  }
  return parsed;
})();
```

Replace line 73: `if (sim > 0.85)` → `if (sim > TOPIC_CHANGE_THRESHOLD)`

NOT touched: `extractor.ts:167` (episode dedup — different purpose).

---

## Files Summary

| File | Action | Tasks |
|------|--------|-------|
| `shared/file-lock.ts` | CREATE | A1 |
| `processor/consolidator.ts` | REWRITE | A1, B1 |
| `processor/index.ts` | MODIFY | A2, A4, A7, B1 |
| `processor/session-tailer.ts` | MODIFY | A3, A7, A9 |
| `processor/extractor.ts` | MODIFY | A9 |
| `processor/recollection-writer.ts` | MODIFY | B4 |
| `mcp/server.ts` | MODIFY | A1, A10 |
| `mcp/search.ts` | MODIFY | A6 |
| `mcp/schema.ts` | MODIFY | B3 |
| `mcp/watcher.ts` | MODIFY | A5 |
| `hooks/pretooluse-recollection.ts` | MODIFY | A8 |
| `scripts/inspect.ts` | CREATE | B2 |
| `package.json` | MODIFY | B2 |

## Implementation Groups (for parallel agent teams)

**Group 1 — Shared + Consolidation** (A1 + A2 + A4 + B1)
Files: `shared/file-lock.ts`, `processor/consolidator.ts`, `processor/index.ts`

**Group 2 — Session Tailer Hardening** (A3 + A7 + A9)
Files: `processor/session-tailer.ts`, `processor/extractor.ts`

**Group 3 — MCP Server Hardening** (A1-server, A5, A6, A10)
Files: `mcp/server.ts`, `mcp/search.ts`, `mcp/watcher.ts`

**Group 4 — Schema + Hook + Features** (A8, B3, B4)
Files: `mcp/schema.ts`, `hooks/pretooluse-recollection.ts`, `processor/recollection-writer.ts`

**Group 5 — Inspection CLI** (B2)
Files: `scripts/inspect.ts`, `package.json`

## Testing Strategy

1. **File lock:** Two concurrent `withFileLock` calls on same path — second should block then succeed
2. **Partial line:** Write half a JSON line to test JSONL, trigger watcher, then complete it — both halves should parse correctly
3. **PID atomicity:** Start two daemon instances simultaneously — only one should acquire the PID
4. **FTS5 migration:** Run `initDb` against existing v2 DB, verify `episodes_fts` has 2 columns, verify existing episodes are searchable by entity name
5. **Watcher:** Save to MEMORY.md, verify watcher fires and re-indexes
6. **Search fallback:** Query with nonsense FTS text but meaningful vector — should still return results
7. **Tailer eviction:** Create a tailer for a non-existent file — should be evicted on next scan
8. **Consolidation:** Insert test episodes with high importance + access_count >= 3, run consolidation, verify MEMORY.md updated
9. **Inspect CLI:** Run `bun scripts/inspect.ts` and `bun scripts/inspect.ts --json`
10. **Threshold:** Set `ENGRAM_TOPIC_THRESHOLD=0.50`, verify more frequent recollection refreshes

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| File lock deadlock if process crashes holding lock | 5s timeout + stale lock removal |
| FTS5 migration blocks readers | Wrapped in EXCLUSIVE transaction, completes in ms for small/medium DBs |
| Tailer eviction removes active session | Only evicts if file is >7 days stale or missing |
| Consolidation graduates too aggressively | access_count >= 3 threshold + 10/cycle cap |
| Vector fallback returns low-quality results | Still scored and sorted by cosine similarity — low scores naturally sink |
