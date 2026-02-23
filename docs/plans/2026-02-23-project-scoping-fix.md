# Project Scoping Fix — Implementation Plan

**Date:** 2026-02-23
**Approach:** Multi-line JSONL cwd scan + one-directional scope override + migration
**Runtime:** Bun
**Review:** Code-reviewed, 3 critical issues fixed (C1-C3)

## Feature Summary

Fix project-scoping so memories extracted from project-specific sessions are correctly tagged with the project name instead of falling into global scope. Three failure modes identified, all fixed.

## Root Cause Analysis

| Failure Mode | Impact | Cause |
|---|---|---|
| A: Missing `cwd` in JSONL first line | ~80% of globals (478+ episodes) | First JSONL line is a `snapshot` entry with no `cwd` field. Resolver returns null → all episodes go global |
| B: LLM scope misclassification | ~5-10% per session | gpt-4.1-nano returns `scope: "global"` for project-specific content |
| C: Root dir not flagged | 126 episodes as "Projects" | `CLAUDE_MEMORY_PROJECT_ROOTS` not set → `/Desktop/Projects` gets `projectName="Projects"` |

## Architecture

### Fix 1: Multi-Line JSONL Scan (`shared/project-resolver.ts`)

**Review fix C2:** The original plan proposed decoding the JSONL directory path (e.g., `-Users-ethangabis-Desktop-Projects-MM` → `/Users/.../MM`). The reviewer identified this is **fundamentally broken** for project names containing dashes (e.g., `claude-memory` → `claude/memory`). The encoding is lossy and cannot be reversed reliably.

**New approach:** Instead of reading only the first line, scan the first N lines of the JSONL file looking for any entry with a `cwd` field. The first line is often a `snapshot` entry (no cwd), but subsequent user/assistant message entries DO contain `cwd`.

**Modify `resolveFromJsonlSync()`:**
```
1. Read JSONL file in chunks (existing CHUNK_SIZE approach)
2. Instead of stopping at the first line, continue scanning up to 10 lines or 256KB
3. For each parsed line, check if entry.cwd exists
4. Return the first valid cwd found
5. If no cwd found after 10 lines → return fallback (null project)
```

This fixes **Failure Mode A** with minimal code change — just extend the existing line-reading loop.

### Fix 2: One-Directional Scope Override (`processor/extractor.ts`)

**Review fix C3:** The original plan forced ALL episodes from project sessions to `scope='project'`. The reviewer correctly identified this eliminates the LLM's ability to mark genuinely global memories (e.g., user preferences discovered during a project session).

**New approach:** One-directional override only. When `projectName` is set and `isRoot` is false, override the LLM's `scope` from `global` → `project` (the LLM is wrong to call project-specific work "global"). But preserve the LLM's `project` → `global` decisions (cross-project mentions, user preferences).

```typescript
// In upsertEpisode — one-directional override
let effectiveScope = candidate.scope;
if (projectName && !isRoot && candidate.scope === 'global') {
  // LLM said global but we're in a specific project — override to project
  effectiveScope = 'project';
}
if (!projectName || isRoot) {
  // Root/unknown session — everything is global
  effectiveScope = 'global';
}
```

**Also:** Add `isRoot` parameter to `upsertEpisode()` signature. Currently `isRoot` is only passed to `extractMemories()`. The call chain: `SessionTailer` already stores `this.projectIsRoot` (line 116) — pass it through to `upsertEpisode()` at line 423.

This fixes **Failure Mode B** while preserving nuanced scope decisions.

### Fix 3: Configure Root Paths (`~/.claude-memory/.env`)

**Review fix C1:** The original plan added the env var to `engram-start.sh`, but the launchd daemon uses `--env-file=~/.claude-memory/.env` directly — `engram-start.sh` is only for manual runs. The env var must go in the `.env` file.

Add to `~/.claude-memory/.env`:
```
CLAUDE_MEMORY_PROJECT_ROOTS=/Users/ethangabis/Desktop/Projects:/Users/ethangabis
```

This ensures both the home directory and the Projects parent are treated as root contexts, fixing **Failure Mode C**.

### Fix 4: Migration Script (`scripts/migrate-project-scoping.ts`)

**Step 0: Backup**
```bash
cp ~/.claude-memory/memory.db ~/.claude-memory/memory.db.backup-20260223
```

**Step 1: Build session→project mapping**
- Scan all JSONL files in `~/.claude/projects/*/`
- For each JSONL file, use the UPDATED `resolveProjectFromJsonlPath()` (multi-line scan) to get project name
- Build a map: `sessionId → { projectName, isRoot }`
- Note: JSONL files persist on disk even after `MAX_FILE_AGE_DAYS` tailer eviction — the files are never deleted, only the tailers are stopped

**Step 2: Re-scope global episodes**
- Query all episodes where `scope = 'global'`
- For each episode, look up `session_id` in the session→project mapping
- If a project mapping exists AND `isRoot` is false:
  - Update `scope = 'project'`, `project = projectName`
- If no mapping found, or `isRoot` is true:
  - Leave as `scope = 'global'` (genuinely global or unknown)

**Step 3: Fix "Projects" episodes**
- Query all episodes where `project = 'Projects'`
- These are from root-level sessions that should be global
- Update `scope = 'global'`, `project = NULL`

**Step 4: Report**
- Print: X episodes re-scoped to project, Y left as global, Z "Projects" fixed to global
- Print breakdown by project for verification

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `shared/project-resolver.ts` | Modify | Extend `resolveFromJsonlSync()` to scan first 10 JSONL lines for `cwd` |
| `processor/extractor.ts` | Modify | Add `isRoot` to `upsertEpisode()` signature, replace scope logic with one-directional override |
| `processor/session-tailer.ts` | Modify | Pass `this.projectIsRoot` to `upsertEpisode()` calls |
| `~/.claude-memory/.env` | Modify | Add `CLAUDE_MEMORY_PROJECT_ROOTS` env var |
| `scripts/migrate-project-scoping.ts` | Create | One-time migration script to re-scope existing episodes |

## Tasks

### Task 1: Backup database
- `cp ~/.claude-memory/memory.db ~/.claude-memory/memory.db.backup-20260223`
- Verify backup exists and matches original size

### Task 2: Fix project-resolver.ts (multi-line cwd scan)
- Modify `resolveFromJsonlSync()` to scan up to 10 lines (or 256KB) looking for any entry with a `cwd` field
- Keep existing first-line-only logic as the fast path (if first line has cwd, use it)
- Only scan further lines when first line lacks cwd
- Clear notes: fallback returns null project (safe default = global scope)

### Task 3: Fix extractor.ts + session-tailer.ts (scope override + isRoot propagation)
- Add `isRoot: boolean` parameter to `upsertEpisode()` signature
- Update `SessionTailer` to pass `this.projectIsRoot` to `upsertEpisode()` at all call sites
- Replace `effectiveScope` logic: one-directional override (global→project when in project, everything→global when isRoot)

### Task 4: Configure root paths in .env
- Add `CLAUDE_MEMORY_PROJECT_ROOTS=/Users/ethangabis/Desktop/Projects:/Users/ethangabis` to `~/.claude-memory/.env`

### Task 5: Create and run migration script
- Import updated `resolveProjectFromJsonlPath()` from shared/project-resolver.ts
- Build session→project map from all JSONL files in `~/.claude/projects/*/`
- Re-scope global episodes with matching non-root project sessions
- Fix "Projects" episodes to global/null
- Print detailed report

### Task 6: Restart daemon and verify
- Restart via launchctl
- Run `bun scripts/dashboard.ts --json` to check episode breakdown
- Verify new extractions from this session are correctly project-scoped

## Review Fixes Applied

- **C1:** Env var goes in `~/.claude-memory/.env`, not `engram-start.sh` (launchd uses `--env-file`)
- **C2:** Dropped dir-path decode (lossy for dashed project names). Using multi-line JSONL scan instead.
- **C3:** Scope override is one-directional only (global→project). Preserves LLM's ability to mark cross-project/global memories.
- **I1:** Added `isRoot` to `upsertEpisode()` signature and tracked full call chain through SessionTailer.
- **I2:** Added `session-tailer.ts` to files-to-modify table (passes isRoot to upsertEpisode).

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Migration misclassifies genuinely global episodes | Low | Only re-scope episodes whose session has a non-root project. Conservative default: leave as global. |
| Multi-line scan reads more data than needed | Very Low | Bounded to 10 lines or 256KB. Most files have cwd on line 2-3. |
| JSONL files deleted between now and migration | Very Low | Files persist on disk; only tailers are evicted by MAX_FILE_AGE_DAYS |
| Backup forgotten | N/A | Task 1 IS the backup — runs before any code/data changes |
| One-directional override misses some cases | Low | Only overrides global→project, which is the conservative direction. LLM can still mark things global. |

## Rollback

```bash
# Restore DB from backup
cp ~/.claude-memory/memory.db.backup-20260223 ~/.claude-memory/memory.db

# Revert code changes
git checkout -- shared/project-resolver.ts processor/extractor.ts processor/session-tailer.ts

# Remove env var
# Edit ~/.claude-memory/.env and remove CLAUDE_MEMORY_PROJECT_ROOTS line

# Restart daemon
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ethangabis.engram.plist
sleep 2
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ethangabis.engram.plist
```
