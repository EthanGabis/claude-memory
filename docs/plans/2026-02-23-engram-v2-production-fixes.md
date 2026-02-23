# R&D Plan: Engram V2 Production Fixes

**Date:** 2026-02-23
**Status:** Draft
**Area:** Full-stack (Processor + MCP + Hooks + Infrastructure)
**Scope:** Large

## Feature Summary

**Idea:** Fix all 18 design issues + 11 newly-discovered holes to make Engram V2 fully operational and production-reliable

**Problem:** The Engram V2 pipeline has never produced output. The daemon was never installed. 18 fundamental design issues prevent reliable daily use. 11 additional data-loss and retrieval holes were found during analysis.

**User:** Developer using Claude Code daily

**How Might We:** How might we make Engram V2 actually work end-to-end so memories are automatically extracted, surfaced, and maintained without manual intervention?

## Chosen Approach

**Option selected:** Option C (Ambitious) with all holes plugged

**Rationale:** The user wants this to be a production-grade, impressive system. Option C provides instant hook-to-daemon signaling via Unix Domain Socket, eager recollection refresh, adaptive extraction thresholds, and comprehensive data-loss prevention.

### Alternatives Considered

| Option | Approach | Why Not |
|--------|----------|---------|
| A (Conservative) | Signal files + fs.watch polling | 5s polling delay, fs.watch race conditions on macOS, less professional |
| B (Recommended) | UDS + all 18 fixes | Missing eager refresh, adaptive thresholds, quality scoring |

## Research Findings

### Codebase Analysis (from docs/rnd/2026-02-23-engram-v2-fixes.md)

- v3 migration has correct BEGIN EXCLUSIVE + retry pattern -- apply to v2 and v4
- fetchEpisodeSnapshot already has LIMIT 500 -- apply to recollection-writer.ts
- scripts/inspect.ts has daemon health logic -- extract for memory_status tool
- Daemon uses path-hash project names, MCP uses basename -- must normalize
- Bun auto-loads .env if WorkingDirectory set in LaunchAgent plist

### Best Practices

- Unix Domain Socket: ~30us RTT, bidirectional, reliable -- recommended for hook-to-daemon signaling
- BEGIN EXCLUSIVE is sufficient for migration locking -- no external lock files
- Tiered archival (Letta-style) + dedup at write (Mem0-style) for memory cleanup
- SWR pattern for one-turn-stale recollections with eager background refresh

## Architecture

### Overview

The daemon gains a UDS listener for instant communication with hooks. The extraction pipeline gains retry-on-failure, adaptive thresholds, and session-end flush. The scope system gains cross-project awareness. Two new MCP tools (memory_forget, memory_status) add correctness and observability.

### Data Flow (revised)

```
User message -> JSONL write
  -> fs.watch (200ms debounce) -> daemon tailer reads
    -> processEntry():
      1. writeRecollections() with SWR (serve stale, refresh later)
      2. Check extraction trigger (adaptive: 5 first, then 15)
      3. If trigger: extract() -> GPT-4.1-nano -> upsert episodes (0.92 dedup, append-on-update)
      4. After extraction: eager refresh recollection for THIS session only

Session end -> stop hook sends UDS flush signal
  -> daemon receives, calls extract() immediately regardless of thresholds
  -> extraction guard prevents interruption until complete

Hook (pretooluse-recollection):
  -> reads recollection file
  -> checks staleness (>5 min AND daemon not running -> skip)
  -> injects memory bites as additionalContext

MCP tools:
  -> memory_recall: hybrid BM25+vector over episodes (project-normalized)
  -> memory_expand: fetch full episode, increment access_count
  -> memory_forget: delete episode by ID (the `episodes_ad` trigger in schema.ts automatically handles FTS5 cleanup on DELETE — no separate FTS5 deletion needed; implementers must NOT manually delete from episodes_fts)
  -> memory_status: daemon health, episode counts, active sessions
```

### Scope Resolution Logic

```
1. Session cwd is a project root (from CLAUDE_MEMORY_PROJECT_ROOTS)
   -> scope='global', project=null, entities tag mentioned projects
2. Session cwd is inside a specific project
   a. LLM detects discussion about a DIFFERENT project
      -> scope='global', entities tag that project name
   b. LLM detects discussion about the CURRENT project
      -> scope='project', project=basename(projectDir)
3. All project names normalized to human-readable basename at write time
```

## Implementation Plan

### Files to Modify

| File | Change | Priority | Issues Addressed |
|------|--------|----------|-----------------|
| processor/index.ts | Add UDS server listener, .env loading, project-root detection, recollection cleanup on eviction | 1 | #1, #11, #17, #18 |
| processor/session-tailer.ts | Make stop() async with flush, adaptive threshold, extraction retry with backoff, non-interruptible extraction guard, scope detection for project roots | 1 | #1, #4, #13, Hole 1, Hole 8, Hole 10 |
| processor/extractor.ts | Raise dedup threshold to 0.92, append-on-update instead of replace, enhance LLM prompt for cross-project scope detection, add project-root awareness | 1 | #5, #8, Hole 2, Hole 4, Hole 11 |
| processor/recollection-writer.ts | Add LIMIT 200 to episode query, eager refresh method, Laplace-smoothed access scoring | 2 | #7, #16, Hole 6, Hole 9 |
| processor/consolidator.ts | MEMORY.md size cap (200 lines) with archival, time-based graduation fallback for high-importance episodes, increase lock timeout | 2 | #10, #14, Hole 6 |
| processor/state.ts | Persist extractionBuffer summary in state for crash recovery | 2 | #4 |
| mcp/server.ts | Add memory_forget tool, add memory_status tool, normalize project names, Laplace-smoothed scoring, BM25 single-hit fix | 1 | #5, #6, #12, #15, #16 |
| mcp/schema.ts | Apply BEGIN EXCLUSIVE + retry to v2 and v4 migrations (copy v3 pattern) | 1 | #2 |
| mcp/search.ts | NO CHANGE — leave existing chunk search BM25 behavior intact | 3 | — |
| hooks/pretooluse-recollection.ts | Add staleness check (timestamp + daemon PID liveness), skip if >5 min stale AND daemon dead | 2 | #9 |
| hooks/stop.ts | Add UDS client to send flush signal to daemon | 1 | #1 |
| shared/file-lock.ts | Increase LOCK_TIMEOUT to 15000ms (from 5000ms) | 3 | #14 |
| shared/uds.ts | NEW: Unix Domain Socket client/server utilities | 1 | #1 |
| shared/project-resolver.ts | NEW: Canonical project name resolution (path-hash to basename, root detection) | 1 | #5, Hole 4, Hole 11 |

### Files to Create

| File | Purpose |
|------|---------|
| shared/uds.ts | UDS server (for daemon) and client (for hooks) utilities. Server: listen on ~/.claude-memory/engram.sock, handle JSON messages. Client: connect, send, disconnect. Handle ECONNREFUSED gracefully. |
| shared/project-resolver.ts | resolveProjectName(jsonlPath): returns {name: string\|null, isRoot: boolean}. Maps path-hash to human-readable basename. Detects if cwd is a project root directory. |
| scripts/engram-start.sh | MODIFY (file already exists). Startup script for LaunchAgent. Sets up environment and runs `bun --env-file=~/.claude-memory/.env processor/index.ts` |

### Build Sequence

Implement in this order (with dependencies):

**Wave 1 -- Foundation (no dependencies, all parallel):**

1. **Task A: Infrastructure** -- shared/uds.ts, shared/project-resolver.ts, shared/file-lock.ts timeout increase, scripts/engram-start.sh, plist updates
2. **Task B: Schema** -- mcp/schema.ts migration locking (apply v3 pattern to v2 and v4)
3. **Task C: MCP Tools** -- mcp/server.ts: add memory_forget + memory_status tools, normalize project names, Laplace scoring, BM25 single-hit fix (episode paths only). mcp/search.ts: NO CHANGE (leave existing chunk search alone).

**Wave 2 -- Processor (depends on Wave 1 A):**

4. **Task D: Daemon Core** -- processor/index.ts: UDS server, .env loading, project-root detection, recollection cleanup. processor/state.ts: persist extraction buffer summary.
5. **Task E: Extraction Pipeline** -- processor/session-tailer.ts: async stop with flush, adaptive threshold, retry with backoff, extraction guard. processor/extractor.ts: 0.92 threshold, append-on-update, cross-project scope, project-root awareness.

**Wave 3 -- Recollection & Consolidation (depends on Wave 1 A, Wave 2):**

6. **Task F: Recollection** -- processor/recollection-writer.ts: LIMIT 200, eager refresh, Laplace scoring. hooks/pretooluse-recollection.ts: staleness check.
7. **Task G: Consolidation** -- processor/consolidator.ts: MEMORY.md size cap + archival, time-based graduation, increased lock scope.

**Wave 4 -- Hook Integration (depends on Wave 1 A):**

8. **Task H: Hooks** -- hooks/stop.ts: UDS flush client. (Note: Task H requires Task D (daemon UDS listener) for testing, even though there's no build-time dependency.)

### Detailed Specifications per Task

#### Task A: Infrastructure (shared/uds.ts, shared/project-resolver.ts, scripts)

**shared/uds.ts:**

```typescript
// UDS Server -- used by daemon
export function createEngramServer(socketPath: string, handler: (msg: any) => void): net.Server
// - Removes stale socket file on startup
// - Listens on socketPath
// - Each connection: read JSON line, call handler, close
// - Returns server instance for cleanup

// UDS Client -- used by hooks
export async function sendEngramMessage(socketPath: string, msg: object): Promise<boolean>
// - Connects to socketPath
// - Writes JSON + newline
// - Returns true on success, false on ECONNREFUSED (daemon not running)
// - 2s timeout on connect
```

Socket path: `~/.claude-memory/engram.sock`

**shared/project-resolver.ts:**

```typescript
export interface ProjectInfo {
  name: string | null;      // human-readable basename or null
  isRoot: boolean;           // true if cwd is a project root directory
  fullPath: string | null;   // full path to project directory
}

export function resolveProjectFromJsonlPath(jsonlPath: string): ProjectInfo
// - Read the first entry of the JSONL file, extract the `cwd` field
// - Use path.basename(cwd) as the human-readable project name
// - Check if cwd is in CLAUDE_MEMORY_PROJECT_ROOTS -- if so, isRoot=true
// - Cache result per JSONL path (only needs to be read once)
// - Fallback: if can't resolve, return {name: null, isRoot: true}

export function resolveProjectFromCwd(cwd: string): ProjectInfo
// - Used by MCP server
// - Walk up from cwd looking for .claude/ directory
// - Return basename of parent
// - Check if cwd itself is a project root
```

The JSONL entries contain a `cwd` field (confirmed from real data). Use this single approach:

1. On first read of a JSONL file, extract the `cwd` field from the first entry
2. Use `path.basename(cwd)` for the human-readable project name
3. Check if `cwd` is in `CLAUDE_MEMORY_PROJECT_ROOTS` for isRoot detection
4. Cache the result per JSONL path (only needs to be read once)

No path-hash reversal or root scanning needed — the `cwd` field is authoritative.

**scripts/engram-start.sh:**

```bash
#!/bin/bash
cd "$(dirname "$0")/.."
exec bun --env-file="$HOME/.claude-memory/.env" processor/index.ts
```

**scripts/com.ethangabis.engram.plist updates:**

- Add `WorkingDirectory` pointing to project root
- Verify ProgramArguments points to engram-start.sh

**scripts/install.sh additions:**

- Symlink plist to ~/Library/LaunchAgents/
- Run launchctl bootstrap or launchctl load

#### Task B: Schema Migration Locking

**mcp/schema.ts:**

Apply the v3 migration pattern to v2 and v4:

> **Note:** Since the DB is already at v4, these migration fixes are dead code for existing installs. This fix only prevents a race condition on fresh installations where two processes start simultaneously. For existing v4 databases, these migration blocks never execute.

For v2 migration (lines 72-124):
- Change `db.exec('BEGIN')` to `db.exec('BEGIN EXCLUSIVE')`
- Add catch block with SQLITE_BUSY retry (same as v3: sleep 6s, re-check version, retry)

For v4 migration (lines 205-226):
- Change `db.exec('BEGIN')` to `db.exec('BEGIN EXCLUSIVE')`
- Add SQLITE_BUSY retry with same pattern
- Keep existing duplicate-column recovery

#### Task C: MCP Tools

**memory_forget tool (mcp/server.ts):**

```typescript
// Register in ListToolsRequestSchema handler:
{
  name: 'memory_forget',
  description: 'Delete a specific memory episode by ID. Use this to remove incorrect or outdated memories.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Episode ID to delete (from memory_recall results)' }
    },
    required: ['id']
  }
}

// Handler:
async function handleMemoryForget(args: { id: string }): Promise<string> {
  // Validate ID format (must start with 'ep_')
  // DELETE FROM episodes WHERE id = ?
  // The `episodes_ad` trigger in schema.ts automatically handles FTS5 cleanup
  // on DELETE — no separate FTS5 deletion needed. Do NOT manually delete from episodes_fts.
  // Return confirmation or "not found"
}
```

**memory_status tool (mcp/server.ts):**

```typescript
// Register:
{
  name: 'memory_status',
  description: 'Check Engram daemon health, episode counts, and system status.',
  inputSchema: { type: 'object', properties: {} }
}

// Handler -- extract logic from scripts/inspect.ts:
async function handleMemoryStatus(): Promise<string> {
  // 1. Check daemon PID file, process alive
  // 2. Count episodes (total, by project, by importance)
  // 3. Count chunks
  // 4. Check recollections dir (file count, staleness)
  // 5. Schema version
  // 6. Format as readable text
}
```

**Project name normalization (mcp/server.ts):**

- Import resolveProjectFromCwd from shared/project-resolver.ts
- Replace `detectProject()` usage with `resolveProjectFromCwd()`
- Ensure all episode queries use the normalized project name

**Laplace-smoothed access scoring (mcp/server.ts):**

- Change `episode.access_count / maxAccess` to `(episode.access_count + 1) / (maxAccess + 1)`
- Apply in handleMemoryRecall scoring

**BM25 single-hit fix (mcp/server.ts only — episode-specific paths):**

- When bm25Min === bm25Max, use `normBm25 = 0.5` instead of `1.0` (moderate score, not full)
- Apply this fix ONLY in server.ts (episode scoring in memory_recall) and recollection-writer.ts
- Leave mcp/search.ts unchanged to avoid regressing existing chunk search behavior

#### Task D: Daemon Core

**processor/index.ts UDS server:**

```typescript
import { createEngramServer } from '../shared/uds.js';

// In main(), after DB init:
const socketPath = path.join(os.homedir(), '.claude-memory', 'engram.sock');
const udsServer = createEngramServer(socketPath, (msg) => {
  if (msg.event === 'flush' && msg.sessionId) {
    const tailer = tailers.get(fullPathForSession(msg.sessionId));
    if (tailer) {
      tailer.flush().catch(err => console.error('[uds] flush failed:', err.message));
    }
  }
});

// In shutdown() -- properly await async stops:
await Promise.all([...tailers.values()].map(t => t.stop()));
udsServer.close();
try { fs.unlinkSync(socketPath); } catch {}
```

**Recollection cleanup on eviction (processor/index.ts):**

```typescript
// In the 60s eviction loop, after removing a stale tailer:
const sessionId = path.basename(tailerPath, '.jsonl');
const recollectionPath = path.join(RECOLLECTIONS_DIR, `${sessionId}.json`);
try { fs.unlinkSync(recollectionPath); } catch {}
const statePath = path.join(RECOLLECTIONS_DIR, `${sessionId}.state`);
try { fs.unlinkSync(statePath); } catch {}
```

**Project root detection (processor/index.ts):**

```typescript
import { resolveProjectFromJsonlPath } from '../shared/project-resolver.js';
// Pass resolved project info to SessionTailer constructor
```

**.env loading:**

Bun handles this via --env-file flag in engram-start.sh. No code change needed in index.ts. But add a startup log:

```typescript
console.error(`[engram] OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : 'NOT SET'}`);
```

**processor/state.ts -- persist extraction context:**

Add `lastBufferSummary: string` to SessionState interface. After each processEntry(), update with a one-line summary of the last message. On crash recovery, the extractor uses this as context for the resumed extraction.

#### Task E: Extraction Pipeline

**processor/session-tailer.ts -- async stop with flush:**

```typescript
// Change stop() from sync to async, with 10s timeout to prevent deadlock:
async stop(): Promise<void> {
  this.stopped = true;
  if (this.extractionBuffer.length > 0) {
    // Flush with timeout — don't block shutdown indefinitely
    await Promise.race([
      this.extract(),
      new Promise(resolve => setTimeout(resolve, 10_000))
    ]);
  }
  // ... rest of stop logic (save offset, close watcher)
}
```

**Adaptive threshold:**

```typescript
const INITIAL_MESSAGE_THRESHOLD = 5;
const STANDARD_MESSAGE_THRESHOLD = 15;

// In class:
private hasExtractedOnce = false;

// In processEntry():
const threshold = this.hasExtractedOnce ? STANDARD_MESSAGE_THRESHOLD : INITIAL_MESSAGE_THRESHOLD;
if (updated.messagesSinceExtraction >= threshold || timeSinceLast >= WARM_TIME_THRESHOLD_MS) {
  await this.extract();
  this.hasExtractedOnce = true;
}
```

**Extraction retry with backoff (NOT clearing buffer on failure):**

```typescript
private extractionBackoff = 0;
private lastExtractionFailure = 0;
private static readonly MAX_EXTRACTION_BUFFER = 100;

async extract(): Promise<void> {
  if (this.extracting) return; // Already in progress

  // Check backoff
  if (this.extractionBackoff > 0 && Date.now() - this.lastExtractionFailure < this.extractionBackoff) {
    // Cap buffer during backoff to prevent unbounded growth
    if (this.extractionBuffer.length > SessionTailer.MAX_EXTRACTION_BUFFER) {
      this.extractionBuffer.splice(0, Math.floor(this.extractionBuffer.length / 2));
    }
    return; // Still in backoff period
  }

  // Guard: non-interruptible
  this.extracting = true;
  try {
    const result = await extractMemories(/* ... */);
    // Success: reset backoff, clear buffer, update state
    this.extractionBackoff = 0;
    this.extractionBuffer.length = 0;
    // ... upsert episodes
  } catch (err) {
    // FAILURE: DO NOT clear buffer. Set backoff.
    this.lastExtractionFailure = Date.now();
    this.extractionBackoff = Math.min(
      (this.extractionBackoff || 15000) * 2,  // 15s, 30s, 60s, 120s max
      120000
    );
    console.error('[tailer] extraction failed, retry in', this.extractionBackoff / 1000, 's:', err.message);
  } finally {
    this.extracting = false;
  }
}
```

**processor/extractor.ts -- dedup threshold + append-on-update:**

```typescript
const DEDUP_COSINE_THRESHOLD = 0.92; // Up from 0.85

// In upsertEpisode, UPDATE branch:
if (bestMatch && bestSim > DEDUP_COSINE_THRESHOLD) {
  // APPEND new summary to existing instead of replacing, with size caps
  let mergedSummary = bestMatch.summary + ' | ' + candidate.summary;
  if (mergedSummary.length > 500) {
    mergedSummary = candidate.summary; // Keep the newer one if too long
  }
  let mergedContent = (bestMatch.full_content ?? '') + '\n---\n' + (candidate.full_content ?? '');
  if (mergedContent.length > 4000) {
    mergedContent = candidate.full_content ?? ''; // Keep the newer one if too long
  }
  db.prepare(`UPDATE episodes SET summary = ?, full_content = ?, entities = ?, embedding = ?, accessed_at = ? WHERE id = ?`)
    .run(mergedSummary, mergedContent, candidate.entities, candidateBlob, Date.now(), bestMatch.id);
  return { action: 'update', id: bestMatch.id, embedding: candidateBlob };
}
```

**Cross-project scope detection -- enhance LLM extraction prompt:**

Add to the system prompt in extractMemories():

```
SCOPE RULES:
- Set scope to "project" if the memory is specifically about the current project (PROJECT_NAME).
- Set scope to "global" if:
  - The memory is about the user's preferences, habits, or general knowledge
  - The memory mentions a DIFFERENT project or product by name
  - The memory is about a concept, plan, or idea not tied to the current codebase
  - The current project is a root projects directory (PROJECT_IS_ROOT=true)
- Include mentioned project names, product names, and key concepts in the entities array.
```

Pass `projectName` and `isRoot` flag to extractMemories().

#### Task F: Recollection

**processor/recollection-writer.ts:**

- Add `ORDER BY accessed_at DESC LIMIT 200` to the episode query (line 133-139)
- Add Laplace smoothing: `(episode.access_count + 1) / (maxAccess + 1)` for accessFreq
- Add public `refreshForSession(sessionId)` method that can be called by daemon after extraction

**hooks/pretooluse-recollection.ts -- staleness check:**

```typescript
// After reading recollection file, before injecting:
const MAX_STALE_MS = 5 * 60 * 1000; // 5 minutes
const fileAge = Date.now() - recollection.timestamp;
if (fileAge > MAX_STALE_MS) {
  // Check if daemon is alive
  const pidPath = path.join(os.homedir(), '.claude-memory', 'engram.pid');
  let daemonAlive = false;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    daemonAlive = true;
  } catch {}

  if (!daemonAlive) {
    // Daemon dead + stale recollection -> skip injection
    process.exit(0);
  }
  // Daemon alive but stale -> still inject (daemon may be processing)
}
```

#### Task G: Consolidation

**processor/consolidator.ts -- MEMORY.md size cap:**

```typescript
const MAX_MEMORY_LINES = 200;

// In graduateEpisodes(), after reading existing MEMORY.md:
// Split on section boundaries (## headers) instead of arbitrary line numbers
const sections = existingContent.split(/(?=^## )/m);
const totalLines = existingContent.split('\n').length;
if (totalLines > MAX_MEMORY_LINES) {
  // Archive oldest sections until remaining is under MAX_MEMORY_LINES
  const archivePath = path.join(path.dirname(GLOBAL_MEMORY_PATH), 'archive', `${yearMonth()}.md`);
  let archiveSections: string[] = [];
  let remainingSections = [...sections];
  while (remainingSections.join('').split('\n').length > MAX_MEMORY_LINES && remainingSections.length > 1) {
    archiveSections.push(remainingSections.shift()!);
  }
  if (archiveSections.length > 0) {
    fs.appendFileSync(archivePath, archiveSections.join('') + '\n');
    existingContent = remainingSections.join('');
  }
}
```

**Time-based graduation fallback:**

```typescript
// Add secondary graduation query:
const timeBasedGrads = db.prepare(`
  SELECT * FROM episodes
  WHERE importance = 'high'
  AND graduated_at IS NULL
  AND created_at < ?
  AND scope = 'global'
  ORDER BY created_at ASC
  LIMIT 5
`).all(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days old
```

#### Task H: Hooks

**hooks/stop.ts -- UDS flush signal:**

```typescript
import { sendEngramMessage } from '../shared/uds.js';

// After writing the daily log summary, before the final re-index:
const socketPath = path.join(os.homedir(), '.claude-memory', 'engram.sock');
const sessionId = (payload.session_id ?? payload.sessionId ?? '') as string;
if (sessionId) {
  await sendEngramMessage(socketPath, { event: 'flush', sessionId });
  // Fire-and-forget: the stop hook sends the UDS message and exits.
  // The daemon processes it asynchronously. The JSONL file persists after
  // session end, so the daemon can still read the full transcript.
  // Session-end extraction may work on a "nearly complete" transcript
  // (missing the very last stop hook entry), which is acceptable.
}
```

## Testing Strategy

### Manual Verification

1. Install LaunchAgent: `bash scripts/install.sh` -> verify plist in ~/Library/LaunchAgents/
2. Start daemon: `launchctl kickstart gui/$(id -u)/com.ethangabis.engram` -> verify PID file created
3. Run `memory_status` tool -> verify daemon health report
4. Chat for 5+ messages -> verify first extraction triggers (adaptive threshold)
5. End session -> verify stop hook sends flush signal and extraction completes
6. Start new session -> verify recollection bites appear in tool context
7. Run `memory_recall` -> verify episodes found with correct project names
8. Run `memory_forget` with an episode ID -> verify deletion
9. Kill daemon -> verify pretooluse hook detects staleness and skips injection
10. Discuss "project ideas" from ~/Desktop/Projects/ -> verify scope='global' with entity tags

### Edge Cases

- [ ] Two Claude sessions start simultaneously -> schema migration doesn't crash
- [ ] Daemon crashes during extraction -> buffer preserved, retry on restart
- [ ] OpenAI API down -> extraction retries with backoff, buffer NOT cleared
- [ ] MEMORY.md exceeds 200 lines -> oldest sections archived (split on `## ` headers)
- [ ] Session with 3 messages ends -> flush triggers extraction
- [ ] Cross-project discussion -> scope='global', entities include mentioned projects

## Risk Assessment

### Blast Radius

- UDS server adds a new daemon component -- if it crashes, it could take the daemon down
- Project name normalization changes how episodes are stored -- existing episodes (if any) may need migration
- Adaptive threshold changes extraction timing -- could increase API costs for users with many short sessions

### Regression Risk

- Making stop() async could introduce timing issues in shutdown sequence
- Append-on-update for dedup: mitigated with 500-char summary cap and 4000-char content cap
- MEMORY.md archival moves content at section boundaries (`## ` headers) -- if archival path is wrong, data is lost

### Performance Impact

- UDS listener: negligible (~0 CPU when idle)
- Eager recollection refresh: one additional hybrid search per extraction cycle
- Laplace smoothing: trivial computation change
- LIMIT 200 on recollection query: major improvement (was unbounded)

### Rollback Plan

1. Stop daemon: `launchctl bootout gui/$(id -u)/com.ethangabis.engram`
2. Remove plist: `rm ~/Library/LaunchAgents/com.ethangabis.engram.plist`
3. Git revert to pre-fix commit
4. Restart MCP server (happens automatically on next Claude session)
5. Episodes in DB are preserved regardless of code rollback

## Review Notes

### Code Review Findings
- **Critical:** 5 issues found, all addressed (project resolver, async deadlock, UDS timing, FTS5 clarification, summary size cap)
- **Important:** 8 suggestions incorporated (buffer cap, BM25 scope, archival boundaries, migration scope, dependency note, cleanup code, guard check)
- **Minor:** 6 notes acknowledged (engram-start.sh exists, status cost, formula consistency, PID liveness edge case, line numbers verified, extracting guard)
- **Confidence Score:** 5/10 → addressed all criticals, re-review recommended

### Review Resolution
- C1: Settled on cwd-from-JSONL approach (verified: cwd field exists in real JSONL entries)
- C2: Added 10s timeout + Promise.all in shutdown
- C3: Documented as known limitation (nearly-complete transcript)
- C4: Removed FTS5 language, noted trigger handles it
- C5: Added 500-char summary cap, 4000-char content cap
