# R&D Findings: Engram V2 Production Fixes

**Date:** 2026-02-23
**Feature Summary:** Fix all 18 design issues to make Engram V2 fully operational and production-reliable.

## Codebase Analysis

### Issue Map (18 issues across 15 files)

| # | Severity | File(s) | Key Lines | Issue |
|---|----------|---------|-----------|-------|
| 1 | CRITICAL | session-tailer.ts | stop() L373-399 | No session-end extraction flush |
| 2 | CRITICAL | mcp/schema.ts | v2 L72-124, v4 L205-226 | Schema migration race |
| 3 | IMPORTANT | session-tailer.ts, pretooluse-recollection.ts | L241-257 | Recollections one-turn stale |
| 4 | IMPORTANT | session-tailer.ts, state.ts | L73, L13 | Buffer/counter desync on crash |
| 5 | IMPORTANT | session-tailer.ts L98-103, server.ts L46-64 | projectName formats | Project name mismatch |
| 6 | IMPORTANT | mcp/server.ts | L106-222 | No memory_forget tool |
| 7 | IMPORTANT | recollection-writer.ts | L133-139 | No LIMIT on episode query |
| 8 | IMPORTANT | extractor.ts L208, recollection-writer.ts L13-22 | Threshold 0.85 | Same threshold, different purposes |
| 9 | IMPORTANT | pretooluse-recollection.ts | L67-79 | Stale recollections when daemon down |
| 10 | IMPORTANT | consolidator.ts L79, server.ts L579 | Append-only | MEMORY.md unbounded growth |
| 11 | IMPORTANT | recollection-writer.ts L232-255, index.ts L268-296 | No cleanup | Recollection file accumulation |
| 12 | IMPORTANT | mcp/server.ts | L106-222 | No memory_status tool |
| 13 | IMPORTANT | session-tailer.ts L59 | WARM_MESSAGE_THRESHOLD=15 | Threshold too high |
| 14 | IMPORTANT | file-lock.ts L4, consolidator.ts L57, server.ts L556 | 5s timeout | Lock timeout under load |
| 15 | NICE | recollection-writer.ts L174-179, server.ts L751-755, search.ts L217-219 | normBm25=1.0 | BM25 single-hit artifact |
| 16 | NICE | recollection-writer.ts L194-196, server.ts L766 | access_count=0 | Cold-start scoring penalty |
| 17 | NICE | processor/index.ts L187, server.ts L24 | process.env only | No .env fallback |
| 18 | NICE | scripts/install.sh, com.ethangabis.engram.plist | Missing steps | LaunchAgent not installed |

### Key Patterns Found
- v3 migration already has correct `BEGIN EXCLUSIVE` + retry pattern — apply to v2 and v4
- `fetchEpisodeSnapshot` in extractor.ts already has `LIMIT 500` — apply to recollection-writer.ts
- `scripts/inspect.ts` already has daemon health check logic — extract for memory_status tool
- `withFileLock` in shared/file-lock.ts is cross-process safe — increase timeout for consolidation
- Bun auto-loads .env if WorkingDirectory is set in LaunchAgent plist

### Integration Points
- Daemon project name: derived from JSONL path hash (e.g. `-Users-ethangabis-Desktop-Projects-myapp`)
- MCP project name: derived from `path.basename(cwd)` (e.g. `myapp`)
- These MUST match for project-scoped episode retrieval to work

## Best Practices Research

### Hook-to-Daemon Signaling
- **Recommended: Unix Domain Socket** at `~/.claude-memory/engram.sock`
- ~30us RTT vs ~100-200ms for signal files with fs.watch
- Bidirectional (daemon can acknowledge), reliable, no race conditions
- Alternative: Signal files are simpler but kqueue has known issues on macOS

### Schema Migration Locking
- **Recommended: BEGIN EXCLUSIVE** as application-level mutex
- SQLite's WAL mode + busy_timeout handles concurrent reads
- BEGIN EXCLUSIVE prevents two processes from running migrations simultaneously
- No need for external lock files — SQLite's own locking is sufficient

### Memory Cleanup Patterns
- **Recommended: Tiered archival** (Letta-style) + dedup at write (Mem0-style)
- MEMORY.md size cap at ~200 lines, archive oldest to `archive/YYYY-MM.md`
- Recollection files: delete after 24 hours of inactivity
- Episode compaction: already handled by consolidator's stale compression

### .env Loading in LaunchAgent
- Bun automatically loads .env from working directory
- Set `WorkingDirectory` in plist to project root
- Also use `--env-file` flag as explicit path for robustness

### Stale Recollection Mitigation
- **Recommended: Stale-while-revalidate** — serve last-computed recollection instantly
- Enhancement: eager background refresh after each extraction cycle
- Add timestamp-based staleness indicator (>5 min = warn, >1 hour = skip)

## Key Insights
- The one-turn staleness is architectural — recollections computed from current message can only reference episodes from BEFORE that message. This is inherent and acceptable with SWR.
- Project name mismatch is a silent data silo — episodes exist but project-scoped queries never find them
- Short sessions (5-10 messages) are likely the majority of Claude usage. Without session-end flush + lower threshold, most conversations produce zero episodes.
- Unix Domain Socket for signaling is a significant upgrade over signal files but adds complexity to daemon startup/shutdown

## Assumptions to Validate
- Short sessions (<15 messages) are the majority — importance: high, evidence: medium
- 0.85 cosine threshold with Q4 nomic-embed-text merges distinct facts — importance: high, evidence: medium
- MEMORY.md at 200 lines is a reasonable cap — importance: medium, evidence: low
- UDS adds enough complexity to justify over signal files — importance: medium, evidence: high
