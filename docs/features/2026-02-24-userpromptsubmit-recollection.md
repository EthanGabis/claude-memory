# UserPromptSubmit Memory Injection

**Date:** 2026-02-24
**Status:** Implemented
**Plan:** docs/plans/2026-02-24-userpromptsubmit-recollection.md
**R&D:** docs/rnd/2026-02-24-userpromptsubmit-recollection.md

## Overview

Memories now surface the instant a user sends a prompt — like human recall — rather than waiting until Claude calls a tool. This replaces the PreToolUse hook with a UserPromptSubmit hook that communicates with the Engram daemon via HTTP-over-UDS for real-time recollection computation.

Additionally, cross-project memory boundaries were removed so memories from any project can be surfaced with proper attribution.

## How It Works

1. User submits a prompt in Claude Code
2. The UserPromptSubmit hook (hooks/userpromptsubmit-recollection.ts) fires
3. Hook sends the prompt + sessionId to the Engram daemon via HTTP POST to /recollect on a Unix domain socket
4. Daemon looks up the session's tailer for context (previousEmbedding, projectName)
5. Daemon embeds the prompt using local GGUF model (~5-20ms)
6. Daemon runs hybrid BM25 + vector search across ALL episodes (no project boundaries)
7. Daemon scores results (0.5 * relevance + 0.3 * recency + 0.2 * accessFreq) and returns top-3 "bites"
8. Hook formats bites as additionalContext and returns to Claude Code
9. Claude sees memory bites before processing the prompt
10. Fallback: if daemon unreachable, reads last known recollection file

Performance budget: 50ms Bun startup + 10ms stdin + 240ms fetch = 300ms total.

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| hooks/userpromptsubmit-recollection.ts | Created | New UserPromptSubmit hook that sends prompts to daemon via HTTP-over-UDS |
| hooks/pretooluse-recollection.ts | Deleted | Old PreToolUse hook replaced by the new system |
| processor/index.ts | Modified | Replaced raw UDS server with Bun.serve({ unix }) HTTP server; added /recollect, /flush, /health routes; added stale file purge |
| shared/uds.ts | Modified | Added sendRecollectRequest() and sendFlushRequest() HTTP-over-UDS client functions |
| processor/session-tailer.ts | Modified | Removed writeRecollections from user message path; made previousEmbedding/projectName/projectPath public |
| processor/recollection-writer.ts | Modified | Removed project family scoping — searches ALL episodes regardless of project |
| mcp/server.ts | Modified | Removed cross-project boundary checks from memory_expand, memory_forget, memory_recall; added cross-project attribution |
| hooks/stop.ts | Modified | Updated to use sendFlushRequest() instead of deprecated sendEngramMessage() |

## Architecture Decisions

1. **HTTP-over-UDS over raw UDS**: Enables request-response pattern with proper routing, error codes, and JSON bodies. Much cleaner than the old single-message-per-connection protocol.
2. **Prompt-time recollection**: Memories surface on UserPromptSubmit (before Claude processes anything) instead of PreToolUse (after Claude decides to call a tool). This means text-only responses also get memory context.
3. **Cross-project access with attribution**: Rather than blocking access to memories from other projects, the system now surfaces all relevant memories but marks cross-project ones with `[From project: <name>]`.
4. **Stale file fallback**: If daemon is unreachable, the hook reads the last written recollection file. Stale data is better than no data.
5. **Force=true on /recollect**: Always recomputes recollections since this is triggered by a new user prompt (not a redundant tool call).

## Known Limitations

- 240ms timeout means very large episode databases might occasionally timeout
- No dedup logic in the new hook (the old PreToolUse had complex uuid-based dedup) — not needed since UserPromptSubmit fires once per prompt
- Deprecated createEngramServer and sendEngramMessage remain in uds.ts for backward compatibility

## Testing Notes

- Verify memories appear when sending prompts (check for memory-data blocks in Claude's context)
- Test with daemon running and not running (should fallback gracefully)
- Test cross-project memory access: create memory in project A, switch to project B, verify memory_recall surfaces it with attribution
- Test memory_expand on cross-project episode: should show [From project: X] prefix
- Test memory_forget on cross-project episode: should delete and show attribution in confirmation
- Restart daemon and verify HTTP server comes up on the socket path
