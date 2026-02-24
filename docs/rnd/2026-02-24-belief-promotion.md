# R&D Findings: Belief Promotion to MEMORY.md

**Date:** 2026-02-24
**Feature Summary:** Promote high-confidence beliefs to MEMORY.md as durable facts; demote/remove when confidence drops.

## Codebase Analysis

### MEMORY.md File Paths
- **Project:** `{project_root}/.claude/memory/MEMORY.md`
- **Global:** `~/.claude-memory/MEMORY.md`
- Path resolution: `detectProject()` in server.ts returns `{ root, name }`

### Existing MEMORY.md Write Patterns
- `saveToMemory()` in server.ts: reads file → dedup check → atomic write (tmp + rename) → re-index
- `graduateEpisodes()` in consolidator.ts: similar pattern with withFileLock() + archive overflow
- Both use `withFileLock(path + '.lock')` from shared/file-lock.ts
- MAX_MEMORY_LINES = 200 (cap with archive overflow)

### Consolidation Hook Point
- `runConsolidation()` in consolidator.ts calls:
  1. `graduateEpisodes(db)` — writes to global MEMORY.md
  2. `compressStaleEpisodes(db)`
  3. `runBeliefConsolidation(db, openai, embedProvider)` — processes beliefs
- **Hook point:** After `runBeliefConsolidation()` returns, call `promoteBeliefs(db)`
- Timer: runs at startup (60s) + every 4h via setInterval

### Belief Table Fields Available
- `id`, `statement`, `subject`, `predicate`, `context`, `timeframe`
- `scope` ('global' | 'project'), `project`, `project_path`
- `confidence_alpha`, `confidence_beta` → confidence = α/(α+β)
- `evidence_count`, `status` ('active' | 'archived' | 'revised' | 'merged' | 'split')
- `peak_confidence`, `stability`, `last_reinforced_at`, `last_accessed_at`
- `supporting_episodes`, `contradicting_episodes` (JSON arrays)

### Key Constraints
- MEMORY.md has 200-line cap — need to budget lines for beliefs section
- Multiple processes may write (MCP server via memory_save, processor via graduation + belief promotion)
- withFileLock() already handles concurrent writes
- File watcher in MCP server auto-re-indexes on change

## Best Practices Research

### Marker-Based Section Management (Recommended)
- Use HTML comment markers: `<!-- BELIEFS:BEGIN -->` / `<!-- BELIEFS:END -->`
- Content between markers is fully managed (overwritten each cycle)
- User content outside markers is preserved
- Pattern used by: Terraform (managed blocks), GitHub Actions (PR comments), eslint configs

### Key Gotchas
- Must handle case where markers are missing (first run) — insert at end
- Must handle case where user deletes one marker but not the other — treat as corrupted, re-insert both
- Atomic write (tmp + rename) prevents partial writes on crash
- Use withFileLock() to coordinate with saveToMemory() and graduateEpisodes()

## Key Insights
1. consolidator.ts already writes to MEMORY.md (graduation) — belief promotion fits naturally alongside it
2. withFileLock() and atomic write patterns already exist — just reuse them
3. Need to budget belief section lines within the 200-line cap (graduation already archives overflow)
4. Project-scoped beliefs need project_path to resolve the correct MEMORY.md location

## Assumptions to Validate
- Beliefs section should be at the END of MEMORY.md (after user content and graduated episodes) — importance: medium
- 30 lines is a reasonable budget for beliefs section — importance: medium
- Former beliefs section should be capped (max 5 entries) to prevent bloat — importance: high
