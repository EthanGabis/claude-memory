# R&D Plan: Belief Promotion to MEMORY.md

**Date:** 2026-02-24
**Status:** Reviewed
**Area:** Backend / Data layer
**Scope:** Medium

## Feature Summary

**Idea:** Promote high-confidence beliefs to MEMORY.md so they appear in the LLM's system prompt as durable facts
**Problem:** Beliefs only surface via UserPromptSubmit hook (contextual recall), which the LLM can ignore. High-confidence, well-evidenced beliefs should be treated as established knowledge.
**User:** Claude Code sessions consuming MEMORY.md
**How Might We:** How might we surface the most trusted beliefs directly in the system prompt while gracefully retiring beliefs that lose confidence?

## Chosen Approach

**Option selected:** Dedicated belief-promoter.ts module
**Rationale:** Clean separation of concerns, proper demotion tracking with DB columns, two-stage demotion lifecycle. Hooks into existing consolidation pipeline with minimal changes to other files.

### Alternatives Considered

| Option | Approach | Why Not |
|--------|----------|---------|
| Option A: Inline | Add promotion logic directly in consolidator.ts | Mixes graduation and belief promotion logic, harder to maintain |
| Option C: Separate file | Write to BELIEFS.md alongside MEMORY.md | Requires Claude Code config changes to load extra file — out of our control |

## Research Findings

### Codebase Analysis
- consolidator.ts already writes to MEMORY.md via `withFileLock()` + atomic writes
- `saveToMemory()` in server.ts uses the same pattern — well-established
- MEMORY.md paths: project = `path.join(projectPath, '.claude', 'memory', 'MEMORY.md')`, global = `~/.claude-memory/MEMORY.md`
- MAX_MEMORY_LINES = 200 with archive overflow for graduation
- Beliefs have `scope`, `project`, `project_path` for routing to correct MEMORY.md
- `graduateEpisodes()` only writes to global MEMORY.md — belief promoter will be the first to write to project MEMORY.md files

### Best Practices
- Marker-based section management (`<!-- BEGIN/END -->`) is standard (Terraform, GitHub Actions)
- Atomic write (tmp + rename) prevents partial writes on crash
- withFileLock() coordinates concurrent writers — lock path convention: `memoryPath + '.lock'`

## Architecture

### Overview
A new `processor/belief-promoter.ts` module that:
1. Queries beliefs eligible for promotion/demotion
2. Formats them as bullet points under managed marker sections
3. Writes to the appropriate MEMORY.md file(s)
4. Tracks promotion/demotion state in the beliefs table

### Data Flow
```
runConsolidation()
  → graduateEpisodes(db)
  → compressStaleEpisodes(db)
  → runBeliefConsolidation(db, openai, embedProvider)
  → promoteBeliefs(db)  ← NEW
  returns { graduated, compressed, promoted, demoted, removed }
```

For each distinct project_path (+ NULL for global):
1. Query promotable beliefs (confidence ≥ 0.7, evidence ≥ 3, status = 'active')
2. Query beliefs to demote (promoted but confidence dropped below 0.7)
3. Query beliefs to remove (demoted 30+ days ago OR confidence < 0.5 OR status != 'active')
4. Resolve MEMORY.md path from project_path (or global path for NULL)
5. Verify project directory exists on disk (skip if not)
6. Read file → parse marker sections → rebuild sections → atomic write with file lock

### Path Resolution
```typescript
function resolveMemoryPath(projectPath: string | null): string {
  if (projectPath) {
    return path.join(projectPath, '.claude', 'memory', 'MEMORY.md');
  }
  return path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
}
```
Lock path: `resolveMemoryPath(projectPath) + '.lock'` — matches server.ts and consolidator.ts convention.

### Grouping Query
```sql
-- Group beliefs by target file. NULL project_path = global MEMORY.md
SELECT DISTINCT
  CASE WHEN scope = 'global' THEN NULL ELSE project_path END AS target_path
FROM beliefs
WHERE status = 'active'
  AND (promoted_at IS NOT NULL
    OR (confidence_alpha / (confidence_alpha + confidence_beta) >= 0.7
        AND evidence_count >= 3))
  AND NOT (scope = 'project' AND project_path IS NULL)  -- skip orphaned project beliefs
```

### Marker Format
The beliefs section is placed at the TOP of MEMORY.md (before user content and graduated episodes) so it survives truncation and is always visible to the LLM.

```markdown
<!-- ENGRAM:BELIEFS:BEGIN -->
## Beliefs

- User prefers Bun over Node.js for all projects (confidence: 0.85, evidence: 7)
- The TTS project uses ElevenLabs API for voice generation (confidence: 0.92, evidence: 12)

## Former Beliefs

- [NO LONGER TRUE] User preferred dark mode for all UIs (was: 0.78, now: 0.45, demoted: 2026-02-20)

<!-- ENGRAM:BELIEFS:END -->
```

### Section Position: Top of File
The beliefs marker section is always placed at the very top of MEMORY.md. This ensures:
1. It survives the 200-line truncation (truncation happens from end)
2. It is never archived by `graduateEpisodes()` (which removes oldest `## ` sections from the start — but we place beliefs BEFORE `## ` date sections and the archiver skips content within our markers)
3. The LLM always sees beliefs first

### Graduation Archiver Coordination
Update `graduateEpisodes()` to skip content within `<!-- ENGRAM:BELIEFS:BEGIN -->` / `<!-- ENGRAM:BELIEFS:END -->` markers when counting lines and archiving sections. The beliefs section's line count is excluded from the MAX_MEMORY_LINES budget — it has its own 30-line cap.

### Promotion Criteria
- `status = 'active'`
- `confidence ≥ 0.7` (where confidence = α / (α + β))
- `evidence_count ≥ 3`
- `scope = 'project'` AND `project_path IS NOT NULL` → project MEMORY.md
- `scope = 'global'` → global MEMORY.md
- **Skip:** beliefs where `scope = 'project'` but `project_path IS NULL` (orphaned)

### Two-Stage Demotion
1. **Stage 1 (Former):** Confidence drops below 0.7 OR status changed from 'active' → move to "Former Beliefs" with `[NO LONGER TRUE]` prefix, set `demoted_at = now`
2. **Stage 2 (Remove):** Confidence drops below 0.5 OR `demoted_at` is 30+ days ago OR status is not 'active' → remove from MEMORY.md entirely, log removal via `console.error`, clear `promoted_at` and `demoted_at`

### Ranking Formula
When more beliefs qualify than the cap allows, rank by: `confidence * Math.log(1 + evidence_count)`
This balances confidence with evidence without letting massive evidence counts dominate.

### Line Budget
- Max 30 lines for entire beliefs section (markers + headings + bullets)
- Cap: 10 active beliefs + 5 former beliefs
- Beliefs section has its OWN line budget, separate from the 200-line graduation budget
- Total MEMORY.md max: 200 (graduation) + 30 (beliefs) = 230 lines

## Implementation Plan

### Files to Create

| File | Purpose |
|------|---------|
| `processor/belief-promoter.ts` | Core promotion/demotion logic, MEMORY.md section management |

### Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `mcp/schema.ts` | v11 migration: add `promoted_at`, `demoted_at` columns + composite index | 1 |
| `processor/consolidator.ts` | Call `promoteBeliefs(db)` after belief consolidation, update return type, make archiver skip markers | 2 |

### Data Model Changes

| Table | Change |
|-------|--------|
| beliefs | Add `promoted_at INTEGER DEFAULT NULL` — timestamp when belief was first promoted to MEMORY.md |
| beliefs | Add `demoted_at INTEGER DEFAULT NULL` — timestamp when belief was moved to "Former Beliefs" |
| beliefs | Add composite index `idx_beliefs_promotion (status, promoted_at)` |

### belief-promoter.ts Design

```typescript
// processor/belief-promoter.ts

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { withFileLock } from '../shared/file-lock.js';
import { beliefConfidence } from './belief-utils.js';

const BEGIN_MARKER = '<!-- ENGRAM:BELIEFS:BEGIN -->';
const END_MARKER = '<!-- ENGRAM:BELIEFS:END -->';
const MAX_ACTIVE_BELIEFS = 10;
const MAX_FORMER_BELIEFS = 5;
const PROMOTE_CONFIDENCE = 0.7;
const PROMOTE_MIN_EVIDENCE = 3;
const REMOVE_CONFIDENCE = 0.5;
const DEMOTE_EXPIRY_DAYS = 30;
const MAX_SECTION_LINES = 30;

interface PromotionResult {
  promoted: number;
  demoted: number;
  removed: number;
}

export async function promoteBeliefs(db: Database): Promise<PromotionResult>;
```

**Key functions:**
- `promoteBeliefs(db)` — main entry point, groups by target file, returns counts
- `runPromotionCycle(db, targetPath, beliefs)` — per-file promotion/demotion
- `resolveMemoryPath(projectPath: string | null): string` — `path.join(projectPath, '.claude', 'memory', 'MEMORY.md')` or global
- `parseMarkerSection(content: string): { before: string, section: string, after: string }` — extract existing beliefs section
- `formatBeliefsSection(active, former): string` — render markdown with markers
- `writeMarkerSection(filePath: string, before: string, section: string, after: string): Promise<void>` — atomic write with lock

### Build Sequence

1. **Schema migration (v11)** — add promoted_at, demoted_at columns + index
2. **belief-promoter.ts** — core module with all promotion logic
3. **consolidator.ts integration** — call promoteBeliefs(), update return type, archiver marker skip
4. **Manual test** — verify beliefs appear in MEMORY.md after consolidation

## Testing Strategy

### Manual Verification
- [ ] Run consolidation with beliefs above threshold — verify they appear in MEMORY.md
- [ ] Lower a belief's confidence below 0.7 — verify it moves to "Former Beliefs" with [NO LONGER TRUE] prefix
- [ ] Lower further below 0.5 — verify it's removed entirely and logged
- [ ] Verify user content outside markers is preserved
- [ ] Verify project-scoped beliefs go to correct project MEMORY.md
- [ ] Verify global beliefs go to global MEMORY.md
- [ ] Verify line budget is respected (max 30 lines for beliefs section)
- [ ] Verify concurrent writes don't corrupt (run memory_save during promotion)
- [ ] Verify beliefs section survives graduation archiver (stays at top, not archived)
- [ ] Verify orphaned project beliefs (project_path = NULL) are skipped
- [ ] Verify non-existent project directories are skipped gracefully
- [ ] Verify re-promotion works (confidence recovers after demotion)

## Risk Assessment

### Blast Radius
- Only touches MEMORY.md files (managed section only)
- User content outside markers is never modified
- If markers are corrupted or missing, they get re-inserted cleanly at top of file

### Regression Risk
- Low — new code path, doesn't modify existing graduation logic
- Archiver change is minimal: skip lines between belief markers when counting
- withFileLock() prevents race conditions with saveToMemory() and graduateEpisodes()

### Performance Impact
- Negligible — runs once per consolidation cycle (every 4h + startup)
- Single DB query + one file read/write per project
- Composite index on (status, promoted_at) for efficient queries

### Rollback Plan
- Delete the marker sections from MEMORY.md files (search for ENGRAM:BELIEFS markers)
- Set promoted_at and demoted_at to NULL: `UPDATE beliefs SET promoted_at = NULL, demoted_at = NULL`
- Remove the promoteBeliefs() call from consolidator.ts

## Review Notes

### Code Review Findings (Score: 7/10)
- **Critical (fixed):** Path resolution formula explicitly specified; NULL project_path handling added; lock path convention documented; orphaned project beliefs filtered out
- **Important (fixed):** Archiver skips marker section; return type includes promotion stats; section position is top-of-file; status-change demotion handles archived beliefs; ranking formula uses log(evidence)
- **Minor (noted):** Former beliefs prefixed with [NO LONGER TRUE] for clarity; non-existent project directories skipped; index added for future scale
