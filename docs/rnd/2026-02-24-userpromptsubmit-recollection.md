# R&D Findings: UserPromptSubmit Recollection Injection

**Date:** 2026-02-24
**Feature Summary:** Redesign the Engram recollection pipeline so memories are injected into Claude's context the instant the user sends a prompt (UserPromptSubmit), replacing the current PreToolUse delivery mechanism.

## Codebase Analysis

### Current Recollection Data Flow
```
User types message
  → Claude Code writes JSONL entry
  → fs.watch fires (200ms debounce)
  → SessionTailer.readNewLines()
  → processEntry() detects role=user
  → writeRecollections() called
    ├─ embed user message (local GGUF, ~5-20ms)
    ├─ topic gate: cosine_sim > 0.85 → skip
    ├─ BM25 + vector search (~1-10ms)
    ├─ score: 0.5*relevance + 0.3*recency + 0.2*accessFreq
    ├─ take top-3
    └─ atomic write: recollections/<sessionId>.json
  → [later] PreToolUse hook reads file → injects additionalContext
```

### Key Files
| File | Role |
|------|------|
| `processor/recollection-writer.ts` | Computes recollections (embed + search + score) |
| `hooks/pretooluse-recollection.ts` | Current delivery: reads JSON, injects into context |
| `processor/session-tailer.ts` | Triggers recollection on live user messages |
| `processor/index.ts` | Daemon entrypoint, UDS socket handler |
| `shared/uds.ts` | Fire-and-forget UDS client/server |
| `~/.claude-memory/recollections/<sessionId>.json` | Pre-computed memory bites |

### Recollection JSON Format
```json
{
  "messageUuid": "ad2cdc53-...",
  "timestamp": 1771870691314,
  "bites": [
    { "id": "ep_70bc84...", "bite": "[Memory flash: ...]", "date": 1771868935606, "importance": "normal" }
  ]
}
```

### IPC Infrastructure
- UDS at `~/.claude-memory/engram.sock` — currently fire-and-forget only
- Single command: `{ event: "flush", sessionId }` — forces extraction
- Protocol: one-shot, no response. Client writes JSON + EOF, server parses on 'end'
- 2s connect timeout, 10s idle timeout, 64KB max

### Timing Analysis
| Phase | Latency |
|-------|---------|
| JSONL write | 0ms |
| fs.watch debounce | +200ms |
| readNewLines + parse | +1-5ms |
| embed (local GGUF) | +5-20ms |
| BM25 + vector search | +1-10ms |
| File write | +1ms |
| **Total daemon path** | **~220-240ms** |

## Claude Code Hook Capabilities

### UserPromptSubmit (critical findings)
- **CAN return `additionalContext`** via `hookSpecificOutput` — same as PreToolUse
- **Receives `prompt` field** in stdin JSON — the actual user message text
- **Fires on EVERY prompt** (no matcher support) — fires before Claude processes
- **Default timeout: 600s** for command hooks — plenty of budget
- **Can block prompt** with `decision: "block"` or exit code 2

### Output format
```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "Memory context injected here"
  }
}
```

### All Hook Events (17 total)
SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Notification, SubagentStart, SubagentStop, Stop, TeammateIdle, TaskCompleted, ConfigChange, WorktreeCreate, WorktreeRemove, PreCompact, SessionEnd

## Best Practices Research

### IPC Pattern Comparison

| Approach | Latency | Relevance | Complexity | Fallback |
|----------|---------|-----------|------------|----------|
| HTTP-over-UDS (Bun.serve + fetch) | 100-300ms | Highest (real-time prompt) | Medium | File fallback |
| Raw UDS request-response | 100-300ms | Highest | Low-Medium | File fallback |
| File-based (move PreToolUse → UserPromptSubmit) | <5ms | Good (1-turn lag) | Very Low | Native |

### Recommended: HTTP-over-UDS (Bun.serve + fetch)
- Bun supports `fetch()` with `unix` option — first-class UDS support
- Bun supports `Bun.serve({ unix })` — HTTP server over UDS
- UDS round-trip: ~0.05-0.13ms (kernel IPC)
- Total expected: 100-300ms (embedding + search dominate)
- Graceful fallback to stale file when daemon is down
- Extensible (add /health, /stats routes later)

### Bun API (confirmed)
```ts
// Server (daemon)
Bun.serve({
  unix: socketPath,
  async fetch(req) {
    const { prompt, sessionId } = await req.json();
    const bites = await computeRecollections(prompt, sessionId);
    return Response.json({ bites });
  },
});

// Client (hook)
const res = await fetch("http://localhost/recollect", {
  unix: socketPath,
  method: "POST",
  body: JSON.stringify({ prompt, sessionId }),
});
```

## Key Insights

1. **The hook receives the prompt text** — this is the game-changer. We can bypass the entire JSONL → fs.watch → tailer pipeline and send the prompt directly to the daemon for real-time embedding + search.

2. **The JSONL write may not exist yet when UserPromptSubmit fires** — so the daemon's tailer-based recollection pipeline can't serve the current message. Direct IPC is the only way to get real-time recollections.

3. **HTTP-over-UDS gives us request-response with zero protocol design** — Bun's native support means we get HTTP semantics (status codes, content-type, streaming) over a Unix socket for free.

4. **The existing fire-and-forget UDS can coexist or be unified** — either keep two sockets (raw for flush, HTTP for recollect) or migrate everything to HTTP routes.

## Assumptions to Validate
- Bun.serve with `unix` option works reliably on macOS (high confidence — no known issues)
- Hook can block for 300-500ms without noticeable UX degradation (medium confidence — needs testing)
- Embedding model responds consistently under 200ms when warm (high confidence from current data)
- Two Bun.serve listeners on different sockets in the same process work correctly (medium confidence)
