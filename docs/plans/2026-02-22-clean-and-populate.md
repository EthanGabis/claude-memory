# Implementation Plan: Clean & Populate Memory System

**Date:** 2026-02-22
**Status:** Awaiting approval
**Previous plan:** docs/plans/2026-02-21-openclaw-parity.md (all 5 gaps closed)
**Reviewed:** Plan reviewer scored 6/10; all CRITICAL and IMPORTANT issues addressed below.

---

## Feature Summary

**Idea:** Clean up competing memory systems and populate the empty Global MEMORY.md with curated knowledge extracted from existing daily logs
**Area:** Memory infrastructure — operational cleanup, not architectural
**Type:** Enhancement — the architecture is already 1:1 with OpenClaw; the problem is operational gaps
**Problem:** 3 competing memory systems cause confusion; Global MEMORY.md is empty despite 5,267 indexed chunks of daily logs; claude-mem hooks still fire despite plugin being disabled
**User:** Ethan — so Claude has full cross-session context
**Scope:** Medium (few hours)
**Success:** Single unified memory system with curated MEMORY.md, no ghost hooks, clean process state

---

## Current State (from research)

### What's Working
- claude-memory MCP server: 3 tools, 3 hooks, hybrid BM25+vector search
- 5,267 chunks indexed, 99.8% have embeddings (local GGUF)
- 8 global daily logs + project-level logs across 3 project dirs
- File watcher, MMR re-ranking, temporal decay — all operational

### What's Broken
1. **Global MEMORY.md** — contains only `# Global Memory\n\n` (no curated knowledge)
2. **claude-mem hooks still fire** — plugin is disabled but 5 hook entries remain in settings.json
3. **Auto memory directory empty** — `~/.claude/projects/-Users-ethangabis-Desktop-Projects/memory/` has no files; the system prompt references it but the real system uses `memory_save` MCP tool
4. **Process leak** — multiple MCP server instances accumulate (one per Claude Code session)

---

## Implementation Tasks

### Task 1: Remove claude-mem ghost hooks
**File:** `~/.claude/settings.json`
**Risk:** Low — plugin is already disabled
**Pre-step:** `cp ~/.claude/settings.json ~/.claude/settings.json.bak`

Surgically remove ONLY entries containing `ccm hook` from the hooks section. Per-event breakdown:

| Event | REMOVE (ccm) | KEEP |
|-------|-------------|------|
| Notification | `ccm hook Notification` | afplay sound hook, ntfy hook |
| Stop | `ccm hook Stop` | `bun .../claude-memory/hooks/stop.ts`, afplay hook, ntfy hook |
| UserPromptSubmit | `ccm hook UserPromptSubmit` | Any non-ccm hooks |
| PreToolUse | `ccm hook PreToolUse` | Any non-ccm hooks |
| PostToolUse | `ccm hook PostToolUse` | Any non-ccm hooks |

**Verify after edit:** `grep -c "ccm hook" ~/.claude/settings.json` must return 0. All `bun .../claude-memory/hooks/` entries must still be present.

### Task 2: Update auto memory instructions
**Target:** The auto memory section injected by the system prompt

The system prompt (not `~/.claude/CLAUDE.md`) contains auto memory instructions telling Claude to save to `~/.claude/projects/.../memory/` using Write/Edit tools. Since this is a system prompt feature we can't edit, the fix is to:
1. Add clear instructions in `~/.claude/CLAUDE.md` that OVERRIDE the auto memory behavior
2. Tell Claude to use `memory_save` MCP tool instead (target="memory" for MEMORY.md, target="log" for daily log)
3. State explicitly: "Do NOT use the auto memory directory at `~/.claude/projects/.../memory/`. Use `memory_save` MCP tool for all memory operations."

### Task 3: Populate Global MEMORY.md from existing daily logs
**Write to:** `~/.claude-memory/MEMORY.md`
**Read from ALL of these sources:**
- `~/.claude-memory/memory/*.md` (8 global daily logs)
- `/Users/ethangabis/Desktop/Projects/.claude/memory/*.md` (project-level)
- `/Users/ethangabis/Desktop/Projects/TTS/.claude/memory/*.md` (project-level)
- `/Users/ethangabis/Desktop/Projects/MM/.claude/memory/*.md` (project-level, includes decisions.md)
- `/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/.claude/memory/` (project-level, largest source)

**Extraction rules:**
1. Read ALL files from ALL sources listed above
2. Extract: user preferences, workflow patterns, project facts, architectural decisions, tool preferences, recurring patterns, environment setup
3. **Deduplication:** One canonical entry per topic. If the same fact appears across multiple logs, keep the most recent version only.
4. Organize into sections:
   - `# Global Memory` (required top-level heading)
   - `## User Preferences` — workflow style, tool choices, communication preferences
   - `## Projects` — active projects, tech stacks, key architecture decisions
   - `## Patterns` — recurring solutions, debugging insights, conventions
   - `## Environment` — machine setup, installed tools, configurations
5. **Size constraint:** Target 2,500–3,000 tokens (session-start hook caps global MEMORY.md at 4,000 tokens; leave headroom for growth)
6. Replace the entire file (not append)

### Task 4: Clean up leaked MCP server processes
**Action:** Shell commands

**Pre-step (dry-run):**
```bash
pgrep -fa bun | grep claude-memory
```
Review output to confirm only `mcp/server.ts` processes will be killed (not hooks).

**Execute:**
```bash
pkill -f "claude-memory/mcp/server.ts" || echo "No processes found"
```

**Post-step:** `pgrep -c -f "claude-memory/mcp/server.ts"` — should be 0 (will respawn on next MCP tool call).

### ~~Task 5: Write today's daily log entry~~ DROPPED
The stop.ts hook automatically writes a daily log entry when the session ends. Manual writing would create a redundant entry. Rely on the hook instead.

---

## Parallel Execution

```
Wave 1 (parallel — no dependencies):
  ├── Task 1: Remove claude-mem ghost hooks (settings.json edit)
  ├── Task 4: Clean up leaked processes (shell command)
  └── Task 3: Read all daily logs from ALL sources (research/extraction phase)

Wave 2 (after Wave 1):
  ├── Task 2: Update CLAUDE.md with memory_save override instructions
  └── Task 3: Write curated MEMORY.md (after extraction complete)
```

---

## Files to Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `~/.claude/settings.json` | Modify | Remove 5 stale `ccm hook` entries; keep all other hooks |
| `~/.claude/CLAUDE.md` | Modify | Add override instructions: use `memory_save` MCP tool, not auto memory dir |
| `~/.claude-memory/MEMORY.md` | Replace | Populate with curated knowledge from all daily logs (2,500-3,000 tokens) |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Removing wrong hooks from settings.json | Low | High | Pre-backup; per-event keep/remove table; post-edit grep verification |
| MEMORY.md too large for session-start | Low | Medium | Target 2,500-3,000 tokens; hook truncates at 4,000 tokens |
| Killing MCP processes disrupts active sessions | Medium | Low | Dry-run pgrep first; processes respawn on next tool call |
| Extracted knowledge is inaccurate | Low | Medium | Human review of MEMORY.md before finalizing |
| Missing project-level logs in extraction | Low | High | Explicit enumeration of all 5 source directories |

---

## Testing Strategy

1. After Task 1: `grep -c "ccm hook" ~/.claude/settings.json` → 0; `grep -c "claude-memory/hooks" ~/.claude/settings.json` → 3 (session-start, stop, pre-compact)
2. After Task 3: `memory_search` for known topics (e.g., "TrueTTS", "Ghostty", "dashboard") → MEMORY.md results should appear
3. After Task 4: `pgrep -c -f "claude-memory/mcp/server.ts"` → 0 or 1
4. New session test: Start fresh Claude Code session → verify session-start hook outputs populated MEMORY.md content

---

## Rollback Plan

- Task 1: Restore from `~/.claude/settings.json.bak`
- Task 2: Revert CLAUDE.md changes (remove override section)
- Task 3: Replace MEMORY.md with `# Global Memory\n\n`
- Task 4: Processes respawn automatically, nothing to rollback
