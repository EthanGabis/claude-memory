# R&D Plan: UserPromptSubmit Recollection Injection + Unified HTTP-over-UDS

**Date:** 2026-02-24
**Status:** Reviewed
**Area:** Infrastructure (daemon + hooks + IPC)
**Scope:** Large

## Feature Summary

**Idea:** Redesign the Engram recollection pipeline to deliver memories at prompt-time via a unified HTTP-over-UDS daemon server, and remove cross-project memory barriers so all memories are accessible with project attribution.
**Problem:** Memories currently surface on tool use (PreToolUse), meaning (1) no memories appear if Claude responds with text only, and (2) memories arrive after Claude has started thinking. Additionally, cross-project memories are blocked entirely — `memory_expand` rejects episodes from sibling projects.
**User:** The developer using Claude Code
**How Might We:** How might we deliver pre-computed memory recollections to Claude at the exact moment the user speaks, with sub-second latency, while making all memories accessible across projects?

## Chosen Approach

**Option selected:** Option C — HTTP-over-UDS unified server + cross-project memory access
**Rationale:** Bun.serve + fetch over UDS gives us true request-response with zero custom protocol design. Unifying all daemon IPC on HTTP routes eliminates the split between fire-and-forget UDS and the new request-response pattern. Cross-project access aligns with the user's vision that memories should flow freely — the agent just needs awareness of source project.

### Alternatives Considered

| Option | Approach | Why Not |
|--------|----------|---------|
| A: File Swap | Move PreToolUse hook to UserPromptSubmit, read existing file | Memories lag by 1 turn — stale when topic changes |
| B: HTTP-over-UDS (partial) | Add recollect endpoint but keep raw UDS for flush | Split architecture — two IPC mechanisms for the same daemon |

## Research Findings

### Codebase Analysis
- Recollection pipeline: `session-tailer.ts` → `recollection-writer.ts` → `recollections/<sessionId>.json` → `pretooluse-recollection.ts`
- Daemon UDS: `shared/uds.ts` with fire-and-forget `createEngramServer` / `sendEngramMessage`
- Daemon handler in `processor/index.ts` lines 503-519: only handles `flush` command
- Boundary checks in `mcp/server.ts`: `handleMemoryExpand` (line 868-895) and `handleMemoryForget` (line 992-1020) reject episodes outside current project family
- `handleMemoryRecall` (line 661-735) filters query results by project family via `getProjectFamilyPaths`
- Hook dedup: file-lock based `<sessionId>.state` + `messageUuid` tracking

### Best Practices
- Bun.serve with `unix` option is first-class API — HTTP-over-UDS confirmed working on macOS
- Bun fetch with `unix` option routes through UDS instead of TCP — ~0.05-0.13ms round-trip
- UDS has no known macOS issues (GitHub #8044 was Linux-only)
- AbortController + setTimeout for timeout control on fetch calls
- Graceful fallback to file-based approach when daemon is unreachable

### Claude Code Hook Capabilities
- UserPromptSubmit **CAN return `additionalContext`** via `hookSpecificOutput`
- UserPromptSubmit receives `prompt` field in stdin JSON — the actual user message text
- Fires on EVERY prompt (no matcher support)
- Default timeout: 600s for command hooks
- Output format: `{ hookSpecificOutput: { hookEventName, additionalContext } }`

## Architecture

### Overview

Two changes to the system:

**1. Unified HTTP-over-UDS daemon server**
Replace the raw `net.createServer` UDS with `Bun.serve({ unix })`. All daemon IPC becomes HTTP routes:
- `POST /recollect` — real-time recollection computation (new)
- `POST /flush` — force extraction for a session (migrated from raw UDS)
- `GET /health` — daemon health check (new)

**2. Cross-project memory access**
Remove the family boundary blocks from `memory_expand`, `memory_forget`, and `memory_recall`. Instead, annotate cross-project memories with their source project so the agent knows the context but isn't blocked from reading.

### Data Flow (new)

```
User types message
  → Claude Code fires UserPromptSubmit hook
  → Hook reads prompt + session_id from stdin JSON
  → Hook sends POST /recollect { prompt, sessionId } to daemon via UDS
  → Daemon looks up tailer for sessionId → gets previousEmbedding + projectName
  → Daemon embeds prompt (local GGUF, ~5-20ms)
  → Daemon runs hybrid BM25 + vector search (~1-10ms)
  → Daemon updates tailer.previousEmbedding with new embedding
  → Daemon writes recollection file (for fallback) + returns top-3 bites as HTTP response
  → Hook formats as additionalContext, writes to stdout
  → Claude sees memory bites BEFORE processing the prompt
```

**Fallback path** (daemon unreachable):
```
Hook fetch() fails (ECONNREFUSED / timeout)
  → Hook reads stale recollections/<sessionId>.json from disk
  → Injects previous turn's memories (better than nothing)
  → Logs warning to stderr
```

### IPC Protocol

**Request (hook → daemon):**
```
POST /recollect HTTP/1.1
Content-Type: application/json

{
  "prompt": "let's fix the memory bites feature",
  "sessionId": "abc123-..."
}
```

Note: Hook only sends `prompt` and `sessionId`. The daemon owns all session state — it looks up `projectName` and `previousEmbedding` from the tailer internally.

**Success Response:**
```json
{
  "bites": [
    { "id": "ep_abc123", "bite": "[Memory flash: ...]", "importance": "high" },
    { "id": "ep_def456", "bite": "[Memory flash: ...]", "importance": "normal" }
  ],
  "timestamp": 1771934229712
}
```

**Error Response:**
```json
{
  "error": "No tailer found for session",
  "bites": []
}
```

The hook treats any response with an empty `bites` array (or error) the same — injects nothing.

**Flush (migrated):**
```
POST /flush HTTP/1.1
Content-Type: application/json

{ "sessionId": "abc123-..." }
```

Response: `200 OK` (body irrelevant, fire-and-forget semantics preserved)

**Health (new):**
```
GET /health HTTP/1.1
```

Response: `{ "status": "ok", "pid": 12345, "uptime": 3600000 }`

### Cross-Project Memory Access

**Current (blocking):**
```
memory_expand("ep_f7ba473894f3")
→ Error: Cannot expand memory from project "claude-memory" — not in the current project family.
```

**New (open access with attribution):**
```
memory_expand("ep_f7ba473894f3")
→ [From project: claude-memory]
  Full memory content here...
```

For `memory_recall`: remove the family filter from queries AND stop defaulting `project` to the current project. All episodes are searchable globally. The `project` parameter becomes an optional filter — if provided, it narrows results; if omitted, all projects are searched. Each result includes its `project` field so the agent knows the source.

For `memory_forget`: remove the family boundary check. Add a soft warning in the response when deleting a cross-project episode: `"Deleted memory from project 'X': <summary>"`.

For `memory_search` (in `mcp/search.ts`): same approach — remove family-only filtering, search all projects, annotate source.

For `recollection-writer.ts`: also remove family-scoped filtering so prompt-time recollections search across all projects, consistent with `memory_recall`.

## Implementation Plan

### Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `processor/index.ts` | Replace `createEngramServer` with `Bun.serve({ unix })`, add `/recollect`, `/flush`, `/health` routes. chmod 0o600 on socket after serve starts. Update shutdown to use `server.stop()` instead of `server.close()`. | 1 |
| `shared/uds.ts` | Add `sendRecollectRequest()` HTTP client function using `fetch({ unix })`. Keep `sendEngramMessage()` temporarily for backwards compat. | 1 |
| `processor/session-tailer.ts` | Disable `writeRecollections` call in the `role === 'user'` path (recollection is now triggered by HTTP endpoint). Keep `refreshRecollection` after extraction cycles. Expose `previousEmbedding` as writable property. | 1 |
| `processor/recollection-writer.ts` | Remove project family scoping from episode queries — search all projects. | 1 |
| `hooks/pretooluse-recollection.ts` | DELETE this file — replaced by UserPromptSubmit hook | 2 |
| `~/.claude/settings.json` | Remove PreToolUse recollection hook entry, add UserPromptSubmit hook entry. Also check `.claude/settings.local.json` for project-level overrides. | 2 |
| `mcp/server.ts` | Remove boundary blocks from `handleMemoryExpand` and `handleMemoryForget`. Remove family filter from `handleMemoryRecall` — stop defaulting project to current, make it optional. Add project attribution and cross-project delete warnings. | 3 |
| `mcp/search.ts` | Remove family-only filtering, search all projects when no project specified. | 3 |
| `hooks/stop.ts` | Migrate from `sendEngramMessage()` to `fetch()` with `/flush` route | 3 |

### Files to Create

| File | Purpose |
|------|---------|
| `hooks/userpromptsubmit-recollection.ts` | New hook: sends prompt to daemon via HTTP-over-UDS, formats response as additionalContext, falls back to file on failure |

### Build Sequence

Implement in this order (with dependencies):

1. **HTTP-over-UDS daemon server** (`processor/index.ts`, `shared/uds.ts`)
   - Replace `createEngramServer` with `Bun.serve({ unix })` on the same socket path
   - Set `chmod(socketPath, 0o600)` after serve starts (Bun.serve doesn't do this automatically)
   - Update shutdown path: `server.stop()` instead of `server.close()`, then `unlinkSync(socketPath)`
   - Add router: `POST /recollect`, `POST /flush`, `GET /health`
   - `/recollect` handler: extract `prompt` + `sessionId` from body. Look up session's tailer from the `tailers` Map to get `previousEmbedding` and `projectName`. If no tailer exists (cold/new session), proceed with `previousEmbedding = null` and `projectName = null` (stateless search, no topic gate). Call `writeRecollections()` inline — this both computes bites and writes the fallback file. After call, update `tailer.previousEmbedding = result.embedding`. Return bites as JSON.
   - `/flush` handler: find tailer by sessionId, call `tailer.flush()`. Return 200.
   - `/health` handler: return `{ status: "ok", pid, uptime }`.
   - Add `sendRecollectRequest()` to `shared/uds.ts` — HTTP client using `fetch({ unix })` with AbortController timeout.

2. **Disable tailer-side recollection** (`processor/session-tailer.ts`)
   - Remove or gate the `writeRecollections()` call in the `role === 'user'` processMessage path (recollection now triggered by HTTP). The JSONL-triggered tailer path should NOT also compute recollections — this prevents the race condition of both the hook and the tailer writing recollections for the same message.
   - Keep `refreshRecollection()` call after extraction cycles (these update recollections when new episodes are extracted, no hook involved).
   - Make `previousEmbedding` writable from outside the class (public property or setter) so the `/recollect` handler can update it.

3. **Remove project scoping from recollection-writer** (`processor/recollection-writer.ts`)
   - Remove `getProjectFamilyPaths` usage from episode queries
   - Search all episodes globally (scope = 'global' OR scope = 'project', regardless of family)
   - Each result already carries its `project` field

4. **UserPromptSubmit hook** (`hooks/userpromptsubmit-recollection.ts`)
   - Read stdin JSON → extract `prompt`, `session_id`
   - Budget: Bun cold-start ~50ms, stdin parse ~10ms, leaving ~240ms for fetch. Set AbortController timeout to `240ms` (not 400ms — accounts for process overhead).
   - Call `sendRecollectRequest(socketPath, { prompt, sessionId })` with 240ms timeout
   - On success: format bites as `additionalContext` with prompt-injection defense wrapper (same `<memory-data>` format as current pretooluse hook)
   - On failure/timeout: fall back to reading `recollections/<sessionId>.json` (stale file). If that also fails, exit 0 with no output (graceful degradation).
   - Output JSON: `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } }`

5. **Hook configuration swap** (`~/.claude/settings.json`)
   - Remove PreToolUse recollection hook entry
   - Add UserPromptSubmit hook: `{ type: "command", command: "bun /path/to/hooks/userpromptsubmit-recollection.ts" }`
   - Check `.claude/settings.local.json` and any project-level settings for stale PreToolUse recollection entries

6. **Cross-project memory access** (`mcp/server.ts`, `mcp/search.ts`)
   - `handleMemoryExpand`: remove family boundary check. If episode is from a different project than current, prepend `[From project: <name>]\n\n` to the response text.
   - `handleMemoryForget`: remove family boundary check. Add soft warning: `"Deleted memory from project '<name>': <summary>"` when deleting cross-project episode.
   - `handleMemoryRecall`: remove family filter from BM25 and vector queries. Change `project` default from `detectProject()?.name` to `undefined` — only filter by project when explicitly passed. Each result includes `project` field for attribution.
   - `mcp/search.ts`: remove family-only filtering from `search()` when no project specified.

7. **Migrate flush callers** (`hooks/stop.ts`)
   - Replace `sendEngramMessage(SOCKET_PATH, { event: 'flush', sessionId })` with `fetch("http://localhost/flush", { unix: SOCKET_PATH, method: "POST", body: JSON.stringify({ sessionId }) })`
   - Same fire-and-forget semantics: catch errors and continue

8. **Cleanup**
   - Delete `hooks/pretooluse-recollection.ts`
   - Remove `createEngramServer` from `shared/uds.ts` (keep `sendEngramMessage` as deprecated for any remaining callers)
   - Add daemon startup logic to purge stale `.state` and `.state.lock` files from `RECOLLECTIONS_DIR`

## Testing Strategy

### Manual Verification
- [ ] Restart daemon → verify `Bun.serve({ unix })` starts, logs listening, socket has 0o600 permissions
- [ ] `GET /health` via curl over UDS → verify response
- [ ] Send prompt in Claude Code → verify `UserPromptSubmit` hook fires and injects memory bites
- [ ] Verify memory bites are relevant to the current prompt (not stale/previous turn)
- [ ] Verify no PreToolUse recollection hook fires (setting removed)
- [ ] Kill daemon → send prompt → verify fallback to stale file works (or graceful "no memories")
- [ ] Call `memory_expand("ep_<cross-project-id>")` → verify it succeeds with `[From project: X]` attribution
- [ ] Call `memory_recall` without project param → verify results include episodes from ALL projects
- [ ] Call `memory_recall` with project param → verify results filtered to that project
- [ ] Call `memory_forget` on cross-project episode → verify it deletes with warning message
- [ ] Run `hooks/stop.ts` → verify flush reaches daemon via new HTTP route
- [ ] Test with topic change mid-conversation → verify fresh recollections computed for new topic
- [ ] Verify `previousEmbedding` is updated on tailer after `/recollect` call (topic gate works correctly)

### Edge Cases
- [ ] Daemon slow (>240ms fetch timeout) → hook should timeout and fall back to file
- [ ] Empty episodes table → hook should inject nothing gracefully
- [ ] Very long prompt (>6000 chars) → truncation before embedding
- [ ] Concurrent prompts (multiple Claude sessions) → GGUF embedding serializes; second session may timeout if first is computing. Fallback to file kicks in.
- [ ] Socket file missing → fallback, no crash
- [ ] No tailer for session (cold session) → stateless search with no topic gate, no previousEmbedding
- [ ] Daemon restart while hook is in-flight → fetch fails, fallback to file

## Risk Assessment

### Blast Radius
- **Daemon UDS migration**: affects all IPC callers (stop hook, future hooks). If Bun.serve fails to bind, daemon loses all IPC.
- **Hook swap**: if UserPromptSubmit hook errors, user gets no memories. But Claude still works — degraded, not broken.
- **Cross-project access**: removes a safety boundary. An agent in project A can now delete memories from project B. Acceptable per user's explicit request. Soft warning on cross-project deletes provides visibility.
- **Tailer recollection removal**: if tailer's writeRecollections is disabled but the HTTP endpoint has a bug, sessions get no automatic recollections. Mitigated by: `refreshRecollection` after extraction still runs, and the fallback file from the last successful `/recollect` call persists.

### Regression Risk
- **Stop hook flush**: if the HTTP migration breaks, sessions won't flush on stop. Memories from the final messages are lost until next daemon processing cycle.
- **Recollection timing**: if the HTTP round-trip is slower than expected, prompts feel sluggish. The 240ms fetch timeout + file fallback prevents worst-case blocking.
- **Embedding serialization**: concurrent `/recollect` requests serialize at the GGUF model. Under high concurrency, later requests timeout. Acceptable — fallback file provides coverage.

### Performance Impact
- **Prompt latency**: +100-300ms per prompt submission (embedding + search). This is the trade-off for real-time relevance. Budget: 50ms Bun startup + 10ms stdin + 240ms fetch = 300ms total worst case.
- **Daemon memory**: no increase — same embedding model, same DB. Just HTTP server overhead (~minimal).
- **Socket I/O**: UDS is kernel-level IPC, negligible overhead.

### Rollback Plan
1. Revert `settings.json` to restore PreToolUse hook entry, remove UserPromptSubmit entry
2. Revert `processor/index.ts` to restore raw `createEngramServer`
3. Revert `processor/session-tailer.ts` to restore tailer-side writeRecollections
4. Revert `shared/uds.ts` to remove HTTP client
5. Revert `mcp/server.ts` to restore boundary checks
6. Revert `mcp/search.ts` to restore family filtering
7. Revert `processor/recollection-writer.ts` to restore family scoping
8. Restart daemon

## Review Notes

### Code Review Findings
- **Critical (C1):** `/recollect` handler must get `previousEmbedding` and `projectName` from the tailer, not from the hook. Hook only sends `{ prompt, sessionId }`. — **Fixed:** Plan updated. Handler looks up tailer, extracts state. Falls back to stateless search for cold sessions.
- **Critical (C2):** Race condition — tailer and HTTP endpoint both calling `writeRecollections` for the same message. — **Fixed:** Plan now includes step 2 to disable tailer-side recollection on user messages. `refreshRecollection` after extraction kept.
- **Critical (C3):** 400ms timeout doesn't account for Bun cold-start + stdin parsing. — **Fixed:** Budget split documented: 50ms startup + 10ms stdin + 240ms fetch = 300ms total.
- **Important (I1):** Handler must update `tailer.previousEmbedding` after computation. — **Fixed:** Explicitly stated in step 1.
- **Important (I2):** Fallback file still gets written by `writeRecollections`. — **Fixed:** Explicitly noted.
- **Important (I3):** `memory_recall` default project must stop auto-defaulting. — **Fixed:** Plan specifies changing default to `undefined`.
- **Important (I4):** Cross-project `memory_forget` needs soft warning. — **Fixed:** Added to step 6.
- **Important (I5):** `Bun.serve` uses `.stop()` not `.close()`. — **Fixed:** Added to step 1.
- **Important (I6):** chmod 0o600 on socket after Bun.serve. — **Fixed:** Added to step 1.
- **Minor (M5):** Recollection-writer also needs family filter removed. — **Fixed:** Added step 3.
- **Minor (M6):** Error response format specified. — **Fixed:** Added to IPC protocol section.
- **Confidence Score:** 7/10 → 9/10 (with fixes applied)

### Review Resolution
All 3 critical issues addressed by plan modifications. All 6 important suggestions incorporated. Key minor notes (M5, M6) added. The build sequence was reordered to include step 2 (disable tailer recollection) and step 3 (recollection-writer scoping) as early steps with correct dependencies.
