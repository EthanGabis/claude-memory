# Engram Dashboard — Implementation Plan

**Date:** 2026-02-23
**Approach:** @unblessed/blessed multi-panel TUI
**Runtime:** Bun
**Review:** Code-reviewed, 3 critical issues fixed (C1-C3)

## Feature Summary

Live terminal dashboard for monitoring the Engram V2 memory system. Shows daemon health, episode stats, session activity, recent extractions, and a live log tail. Auto-refreshes every 3 seconds. Single command: `bun scripts/dashboard.ts`.

Also supports `--json` mode for scriptability (prints data once and exits).

## Layout

```
┌──────────────────────── Engram Dashboard ──────────────────────────┐
│                                                                     │
│  ┌─ Daemon Health ───────────┐  ┌─ Episode Stats ────────────────┐ │
│  │ Status: RUNNING (5m)      │  │ Total: 838  Schema: v4         │ │
│  │ PID: 94151                │  │                                │ │
│  │ RSS: 295MB / 400MB [====] │  │ By Project:                    │ │
│  │ Embed fails: 0 (session)  │  │   global    588                │ │
│  │ 429 errors: 0 (session)   │  │   TrueTTS   105                │ │
│  │ Sessions: 2 tracked       │  │   Projects   99                │ │
│  │ Recollections: 92         │  │   MM          43               │ │
│  └───────────────────────────┘  │ Chunks: 5308  Cache: 1204     │ │
│                                  └────────────────────────────────┘ │
│  ┌─ Active Sessions ─────────────────────────────────────────────┐ │
│  │ Session   Offset     MsgQueue  LastExtract  Recollection      │ │
│  │ f9a1016c  34.4MB     3         2m ago       active            │ │
│  │ fd53955e  32KB       0         5m ago       active            │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─ Recent Extractions ──────────────────────────────────────────┐ │
│  │ 2m ago  [high] User preferences for CLI dashboard design      │ │
│  │ 5m ago  [norm] Engram V2 fixes applied successfully           │ │
│  │ 12m ago [high] Memory system stabilization complete           │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  ┌─ Log ─────────────────────────────────────────────────────────┐ │
│  │ [tailer:f9a1016c] Extraction: 1 added, 0 updated             │ │
│  │ [engram] Processor running (PID: 94151)                       │ │
│  └───────────────────────────────────────────────────────────────┘ │
│  q:quit  r:refresh  tab:focus  j/k:scroll  1-5:panels            │
└─────────────────────────────────────────────────────────────────────┘
```

## Architecture

### File Structure

```
scripts/lib/engram-data.ts    # Shared data layer (used by both inspect.ts and dashboard)
scripts/dashboard.ts          # Entry point
scripts/dashboard/
  layout.ts                   # Screen setup + panel layout
  panels.ts                   # Individual panel renderers
  types.ts                    # Shared types
```

**Key decision:** Extract data functions from `inspect.ts` into `scripts/lib/engram-data.ts` so both tools share the same data layer. Prevents drift between inspect and dashboard.

### Data Layer (`scripts/lib/engram-data.ts`)

All data comes from local files + SQLite read-only. No daemon communication needed.

**SQLite connection:** `new Database(DB_PATH, { readonly: true })` + `PRAGMA busy_timeout = 5000` — matches `inspect.ts` pattern. WAL mode handles concurrent reads with daemon's write connection.

**Graceful degradation:** If DB doesn't exist, return empty defaults (don't crash). Dashboard shows "Waiting for database..." state and retries on next refresh.

| Data | Source | Method |
|------|--------|--------|
| Daemon status | `engram.pid` line 1 | `parseInt()` + `process.kill(pid, 0)` |
| Daemon uptime | `engram.pid` line 2 (createdAt timestamp) | `Date.now() - createdAt` |
| RSS | `ps -o rss= -p <pid>` | `Bun.spawn` (10s interval, cached between refreshes) |
| Episode counts | `memory.db` episodes table | `SELECT scope, project, importance, COUNT(*) GROUP BY` |
| Schema version | `memory.db` _meta table | `SELECT value FROM _meta WHERE key = 'schema_version'` |
| Chunk count | `memory.db` chunks table | `SELECT COUNT(*)` |
| Cache count | `memory.db` embedding_cache | `SELECT COUNT(*)` |
| Session states | `engram-state.json` | JSON.parse (handle parse errors gracefully) |
| Recent extractions | `memory.db` episodes | `ORDER BY created_at DESC LIMIT 10` |
| Embed failures | `engram.stderr.log` last 50KB | scan for "Failed to embed" count |
| 429 errors | `engram.stderr.log` last 50KB | scan for "429" count |
| Session count | `engram-state.json` | count of session keys |
| Recollection count | `recollections/*.json` | readdirSync count (30s cache) |
| Log tail | `engram.stderr.log` last 20 lines | read from end of file |

**Review fixes applied:**
- C1: Uptime from PID file line 2 timestamp, NOT file mtime
- C2: RSS via Bun.spawn on 10s interval with caching (not every 3s)
- C3: Log scanning limited to last 50KB, counts labeled "session" (per daemon run)
- I2: DB opened with `{ readonly: true }` + `busy_timeout = 5000`
- I3: Session count from state.json, not log grep
- I5: Graceful "waiting for DB" state instead of crash

### Layout (`layout.ts`)

Uses @unblessed/node Screen + Box widgets:
- Full-screen with border
- Title bar: "Engram Dashboard" centered
- 5 panels: 2-column grid (top) + 3 stacked rows (bottom)
- Footer: keyboard shortcuts
- Auto-refresh: data fetch every 3s, RSS every 10s
- Debounced `resize` event handler for terminal resize

### Panels (`panels.ts`)

5 panel functions, each takes data and returns content string:

1. **Daemon Health** — status indicator (green/red), PID, RSS bar, error counts, session count
2. **Episode Stats** — total + schema version, breakdown by project and importance, chunks + cache
3. **Active Sessions** — table of sessions with offset, message queue, last extraction time, recollection status
4. **Recent Extractions** — last 10 episodes with relative time, importance badge, summary
5. **Log Tail** — last 20 lines of stderr log, color coded by prefix

**Color thresholds** (match daemon constants):
- RSS: green < 300MB, yellow 300-400MB, red > 400MB
- Errors: green = 0, yellow = 1-5, red > 5

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` / `Ctrl+C` | Quit |
| `r` | Force refresh |
| `Tab` | Cycle focus between panels |
| `j` / `k` | Scroll focused panel |
| `1-5` | Jump to panel |

## Dependencies

```json
{
  "@unblessed/node": "8.2.0-alpha.5"
}
```

Single new devDependency. Pin exact alpha version for stability. Already using bun:sqlite and node:fs.

## Tasks

### Task 1: Extract shared data layer + install dependency
- `bun add @unblessed/node@alpha`
- Create `scripts/lib/engram-data.ts` — extract `fetchDashboardData()` from inspect.ts patterns
- Create `scripts/dashboard/types.ts` with `DashboardData` interface
- Refactor `inspect.ts` to import from shared data layer

### Task 2: Implement layout + panels
- Create `scripts/dashboard/layout.ts` — screen setup with @unblessed/node
- Create `scripts/dashboard/panels.ts` — 5 panel renderers
- Color coding, RSS progress bar, relative time formatting
- Debounced resize handler

### Task 3: Wire up entry point + test
- Create `scripts/dashboard.ts` — imports layout + data
- 3-second data refresh, 10-second RSS refresh
- Keyboard bindings
- `--json` mode (fetch once, print, exit)
- Graceful shutdown (close DB, destroy screen)
- Test with daemon running and stopped
- Test keyboard navigation

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| @unblessed alpha breaks | Low | Pin version, fallback to raw ANSI if needed |
| Bun compat issue with TTY | Low | @unblessed uses DI, platform-agnostic core |
| SQLite WAL lock contention | Very low | Read-only + busy_timeout = 5000 |
| Terminal resize breaks layout | Medium | Debounced resize handler |
| Alpha dep in production tool | Low | Dashboard is dev-only, not user-facing |

## Run Command

```bash
# Live TUI
bun scripts/dashboard.ts

# JSON snapshot
bun scripts/dashboard.ts --json
```
