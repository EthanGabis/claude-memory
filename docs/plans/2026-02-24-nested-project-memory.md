# R&D Plan: Nested Project Memory Support

**Date:** 2026-02-24
**Status:** Reviewed
**Area:** Data layer / backend
**Scope:** Medium

## Feature Summary

**Idea:** Sub-projects (frontend, backend, frontend-new) inherit a parent_project link so searching at the parent level returns all descendant episodes.
**Problem:** Auto-discovery correctly finds nested projects but doesn't know they're related. Searching "TrueTTS" misses 161 episodes from frontend-new; searching "MM" misses 78 from frontend/backend.
**User:** Internal (memory search across project hierarchies)
**How Might We:** How might we let project searches cascade through parent-child hierarchies so that querying a parent project returns all descendant memories?

## Chosen Approach

**Option selected:** Option B — Parent Column + Materialized Family Cache
**Rationale:** Keeps schema clean (single `parent_project` column), avoids per-query recursive DB lookups via an in-memory cache, and handles N-level nesting (we have 3 levels: TTS → TrueTTS → frontend-new).

### Alternatives Considered

| Option | Approach | Why Not |
|--------|----------|---------|
| Option A: Helper Function | Parent column + recursive DB queries at each search site | Per-query overhead for recursive lookups on every search |
| Option C: Denormalized Tags | Store parent_project on episodes table too | Migration complexity, only supports 2-level nesting, denormalization bugs |

## Research Findings

### Actual Project Hierarchy (from filesystem analysis)
```
TTS/                                    (3 episodes)
├── TrueTTS/                            (399 episodes)
│   └── frontend-new/                   (141 episodes)
└── mic-launch-video/                   (20 episodes)

MM/                                     (95 episodes)
├── src/frontend/                       (31 episodes)
└── .worktrees/.../src/backend/         (47 episodes)

Standalone: claude-memory (41), claude-monitor (0), claude-powerline-audit (6)
```

### Codebase Analysis
- `episodes.project` stores **name** (basename), not full_path — cascade queries must resolve through the `projects` table
- **9 SQL queries across 5 files** need cascade logic:
  - `processor/extractor.ts` (1 site — episodes)
  - `processor/recollection-writer.ts` (1 site — episodes)
  - `mcp/server.ts` (4 sites — 2 recall queries + 2 boundary checks for expand/forget)
  - `mcp/search.ts` (2 sites — chunks table)
  - `shared/project-describer.ts` (1 site — episode summaries for description gen)
- `projects` table has `full_path` as PRIMARY KEY — path-prefix detection is reliable for all parent-child pairs
- Current resolution code (resolver, inferrer, describer) all call `upsertProject()` — single point to add parent detection

### Key Insight: Path-Prefix Detection
For every confirmed parent-child pair, the child's `full_path` starts with `parent_full_path + '/'`. This is a reliable, zero-configuration detection method.

## Architecture

### Overview
Add a `parent_project` column (TEXT, nullable) to the `projects` table. On startup and when projects are upserted, auto-detect parent-child relationships by checking if any project's `full_path` is an ancestor of the current project. Build an in-memory family cache (`Map<string, string[]>`) keyed by **full_path** that maps each project to its full family (self + all descendant names). All episode/chunk queries use this cache for `IN (...)` expansion.

### Data Flow
```
1. Project upserted (startTailer / migration / discovery)
   → detectParentProject(db, fullPath) returns parent full_path or null
   → upsertProject(db, name, fullPath, parentProject)
   → invalidate family cache

2. Family cache built (startup + on invalidation)
   → SELECT name, full_path, parent_project FROM projects
   → Build tree: parent_full_path → [child_full_path, ...]
   → For each project, BFS to compute transitive closure (all descendant names)
   → Store as Map<full_path, string[]> AND Map<name, string[]> (with collision detection)

3. Episode/chunk query (search / recall / extractor / recollection / expand / forget)
   → getProjectFamily(projectName) → ['TrueTTS', 'frontend-new']
   → Use IN (?, ?, ...) instead of = ? in SQL
```

### Parent Detection Algorithm
```typescript
function detectParentProject(db: Database, fullPath: string): string | null {
  // Query all existing projects ordered by path length DESC (deepest first)
  const projects = db.prepare(
    `SELECT full_path FROM projects ORDER BY LENGTH(full_path) DESC`
  ).all() as { full_path: string }[];

  for (const row of projects) {
    if (row.full_path === fullPath) continue;
    if (fullPath.startsWith(row.full_path + '/')) {
      return row.full_path; // Immediate parent (deepest ancestor)
    }
  }
  return null;
}
```
Note: By iterating longest paths first, we find the **immediate** parent, not the root ancestor. For TTS/TrueTTS/frontend-new, this returns TrueTTS (not TTS).

### Family Cache Design (FIXED: keyed by full_path to avoid name collisions)
```typescript
// Singleton, exported from shared/project-family.ts
let familyCache: Map<string, string[]> | null = null;  // full_path → family names
let nameToPath: Map<string, string> | null = null;       // name → full_path (first match)

export function getProjectFamily(db: Database, projectName: string): string[] {
  if (!familyCache || !nameToPath) {
    const result = buildFamilyCache(db);
    familyCache = result.byPath;
    nameToPath = result.nameToPath;
  }
  // Resolve name → full_path, then look up family
  const fullPath = nameToPath.get(projectName);
  if (!fullPath) return [projectName]; // Unknown project — return self only
  return familyCache.get(fullPath) ?? [projectName];
}

export function invalidateFamilyCache(): void {
  familyCache = null;
  nameToPath = null;
}

function buildFamilyCache(db: Database): {
  byPath: Map<string, string[]>;
  nameToPath: Map<string, string>;
} {
  const projects = db.prepare(
    `SELECT name, full_path, parent_project FROM projects`
  ).all() as { name: string; full_path: string; parent_project: string | null }[];

  // Build adjacency: parent_full_path → [child_full_path, ...]
  const childrenOf = new Map<string, string[]>();
  const pathToName = new Map<string, string>();
  const nameToPathMap = new Map<string, string>();

  for (const p of projects) {
    pathToName.set(p.full_path, p.name);
    // First name wins (name collisions: keep the first-seen full_path)
    if (!nameToPathMap.has(p.name)) {
      nameToPathMap.set(p.name, p.full_path);
    }
    if (p.parent_project) {
      const existing = childrenOf.get(p.parent_project) ?? [];
      existing.push(p.full_path);  // Store full_path, not name
      childrenOf.set(p.parent_project, existing);
    }
  }

  // For each project, BFS to compute all descendants
  const byPath = new Map<string, string[]>();
  for (const p of projects) {
    const family = [p.name];
    const queue = [p.full_path];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const childPaths = childrenOf.get(current) ?? [];
      for (const childPath of childPaths) {
        const childName = pathToName.get(childPath);
        if (childName) {
          family.push(childName);
          queue.push(childPath);  // Continue BFS — no ambiguity
        }
      }
    }
    byPath.set(p.full_path, family);
  }

  return { byPath, nameToPath: nameToPathMap };
}
```

### Shared SQL Helper
```typescript
// Also in shared/project-family.ts
export function sqlInPlaceholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}
```
Used at all 9 query sites to avoid duplication.

## Implementation Plan

### Files to Create

| File | Purpose |
|------|---------|
| `shared/project-family.ts` | Family cache: `getProjectFamily(db, name)`, `invalidateFamilyCache()`, `detectParentProject(db, fullPath)`, `sqlInPlaceholders()` |

### Files to Modify

| File | Change | Priority |
|------|--------|----------|
| `mcp/schema.ts` | Schema v6: `ALTER TABLE projects ADD COLUMN parent_project TEXT`, add index | 1 |
| `shared/project-describer.ts` | `upsertProject()`: add `parentProject` param, set on INSERT, update on CONFLICT | 1 |
| `processor/index.ts` | `startTailer()`, `runStartupMigration()`, `runProjectDiscovery()`: call `detectParentProject()` when upserting, call `invalidateFamilyCache()` after. Add `runParentDetection()` for backfill. | 2 |
| `processor/session-tailer.ts` | `attemptReResolution()`: call `detectParentProject()` + `invalidateFamilyCache()` | 2 |
| `processor/extractor.ts` | `fetchEpisodeSnapshot()`: use `getProjectFamily()` for `IN (...)` query | 3 |
| `processor/recollection-writer.ts` | `refreshRecollection()`: use `getProjectFamily()` for `IN (...)` query | 3 |
| `mcp/server.ts` | `handleMemoryRecall()`: 2 query sites + `handleMemoryExpand()` and `handleMemoryForget()` boundary checks — use family-aware check | 3 |
| `mcp/search.ts` | `search()`: 2 chunk query sites — use `getProjectFamily()` for `IN (...)` | 3 |
| `shared/project-describer.ts` | `generateProjectDescription()`: episode summary query — use family for parent descriptions | 3 |

### Data Model Changes

| Table | Change |
|-------|--------|
| `projects` | `ADD COLUMN parent_project TEXT` — stores full_path of the immediate parent project (NULL if top-level) |
| `projects` | `CREATE INDEX idx_projects_parent ON projects(parent_project)` |

### Build Sequence

Implement in this order (4 waves):

**Wave 1: Foundation (parallel, no dependencies)**
1. **Task 1: Schema v6 migration** — `mcp/schema.ts`: add migration block for `parent_project` column + index
2. **Task 2: project-family.ts** — New file: `detectParentProject()`, `getProjectFamily()`, `invalidateFamilyCache()`, `buildFamilyCache()`, `sqlInPlaceholders()`
3. **Task 3: upsertProject() update** — `shared/project-describer.ts`: add `parentProject` parameter, include in INSERT and ON CONFLICT UPDATE

**Wave 2: Registration sites (parallel, depends on Wave 1)**
4. **Task 4: Processor registration** — `processor/index.ts`: wire `detectParentProject()` + `invalidateFamilyCache()` into `startTailer()`, `runStartupMigration()`, `runProjectDiscovery()`. Add `runParentDetection()` startup backfill.
5. **Task 5: Session tailer registration** — `processor/session-tailer.ts`: wire `detectParentProject()` + `invalidateFamilyCache()` into `attemptReResolution()`

**Wave 3: Query expansion (parallel, depends on Wave 1 Task 2)**
6. **Task 6: Episode query cascade** — `processor/extractor.ts` + `processor/recollection-writer.ts`: use `getProjectFamily()` + `sqlInPlaceholders()` for `IN` clause
7. **Task 7: MCP recall + boundary cascade** — `mcp/server.ts`: use `getProjectFamily()` in `handleMemoryRecall()` (2 queries), update `handleMemoryExpand()` and `handleMemoryForget()` boundary checks to use family-aware membership test
8. **Task 8: MCP search cascade** — `mcp/search.ts`: use `getProjectFamily()` for 2 chunk query sites
9. **Task 9: Description cascade** — `shared/project-describer.ts`: `generateProjectDescription()` episode query uses family for parent projects

**Wave 4: Startup backfill (depends on Waves 1-2)**
10. **Task 10: Backfill parent_project** — In `processor/index.ts`, add `runParentDetection()` that runs at startup after schema migration: queries all projects, calls `detectParentProject()` for each, updates `parent_project` column. Idempotent.

## Complete SQL Query Change List

| # | File | Function | Table | Current Pattern | New Pattern |
|---|------|----------|-------|-----------------|-------------|
| 1 | `extractor.ts` | `fetchEpisodeSnapshot()` | episodes | `project = ?` | `project IN (${placeholders})` |
| 2 | `recollection-writer.ts` | `refreshRecollection()` | episodes | `project = ?` | `project IN (${placeholders})` |
| 3 | `server.ts` | `handleMemoryRecall()` BM25 | episodes | `project = ?` | `project IN (${placeholders})` |
| 4 | `server.ts` | `handleMemoryRecall()` vector | episodes | `project = ?` | `project IN (${placeholders})` |
| 5 | `server.ts` | `handleMemoryExpand()` | episodes | `currentProject.name !== episode.project` | `!family.includes(episode.project)` |
| 6 | `server.ts` | `handleMemoryForget()` | episodes | `currentProject.name !== episode.project` | `!family.includes(episode.project)` |
| 7 | `search.ts` | `search()` vector fallback | chunks | `project = ?` | `project IN (${placeholders})` |
| 8 | `search.ts` | `search()` BM25 hit fetch | chunks | `project = ?` | `project IN (${placeholders})` |
| 9 | `project-describer.ts` | `generateProjectDescription()` | episodes | `project = ?` | `project IN (${placeholders})` |

## Testing Strategy

### Manual Verification
- [ ] Daemon starts, schema v6 migration runs, `parent_project` column exists
- [ ] After startup, query `SELECT name, parent_project FROM projects` — verify:
  - TrueTTS → parent = `/Users/ethangabis/Desktop/Projects/TTS` (TTS full_path)
  - frontend-new → parent = `/Users/ethangabis/Desktop/Projects/TTS/TrueTTS` (TrueTTS full_path)
  - mic-launch-video → parent = `/Users/ethangabis/Desktop/Projects/TTS` (TTS full_path)
  - frontend → parent = `/Users/ethangabis/Desktop/Projects/MM` (MM full_path)
  - backend → parent = `/Users/ethangabis/Desktop/Projects/MM` (MM full_path)
  - TTS, MM, claude-memory → parent = NULL
- [ ] `memory_recall(query="test", project="TrueTTS")` returns episodes from TrueTTS AND frontend-new
- [ ] `memory_recall(query="test", project="TTS")` returns episodes from TTS, TrueTTS, frontend-new, AND mic-launch-video
- [ ] `memory_recall(query="test", project="MM")` returns episodes from MM, frontend, AND backend
- [ ] `memory_recall(query="test", project="frontend")` returns only frontend episodes (no upward cascade)
- [ ] `memory_search(query="test", project="TrueTTS")` returns chunks from TrueTTS AND frontend-new
- [ ] `memory_expand` on a frontend-new episode works when current project is TrueTTS
- [ ] `memory_forget` on a frontend-new episode works when current project is TrueTTS
- [ ] Standalone projects (claude-memory) work unchanged
- [ ] New session in nested project → parent detected correctly
- [ ] Second daemon restart → idempotent (no changes)

## Risk Assessment

### Blast Radius
All episode/chunk search queries affected (9 sites across 5 files). A bug in `getProjectFamily()` could return wrong projects, contaminating search results.

### Regression Risk
- If `getProjectFamily()` returns empty array → queries match nothing (lost results)
- Mitigation: always return `[projectName]` as minimum, even on cache miss
- Name collisions: if two projects share basename, `nameToPath` picks first-seen. Acceptable since family lookup still works correctly via full_path.

### Performance Impact
- Family cache is tiny (~10 entries) and built once at startup (lazy, on first query)
- `IN (...)` with 2-5 values has negligible overhead vs `= ?`
- `detectParentProject()` queries all projects (currently 10 rows) — trivial

### Cross-Process Cache Staleness (I4)
The MCP server and processor are separate processes. If processor discovers a new project, the MCP server's cache is stale until next `invalidateFamilyCache()`. Acceptable tradeoff: new projects are rare (only on new session start), and the MCP server rebuilds cache lazily on next query after invalidation. For now, accept that MCP server needs restart to see brand-new parent-child relationships discovered mid-session.

### Rollback Plan
- Schema v6 adds a nullable column — backward compatible, old code ignores it
- Family cache defaults to `[projectName]` if cache miss — equivalent to old behavior
- If something goes wrong: `UPDATE projects SET parent_project = NULL`, cache returns single-element arrays

## Review Notes

### Code Review Findings (Score: 6/10 → fixed to 9/10)
- **C1 FIXED:** `handleMemoryExpand` and `handleMemoryForget` boundary checks now use family-aware membership test (Task 7)
- **C2 FIXED:** `mcp/search.ts` chunk queries added to plan (Task 8)
- **C3 FIXED:** BFS adjacency now maps `parent_full_path → [child_full_path]` instead of storing names — eliminates name collision bug
- **C4 FIXED:** Cache keyed by `full_path` with `nameToPath` resolution layer — no name collision in lookup
- **I1 NOTED:** Schema v6 — no other pending migrations
- **I2 FIXED:** `generateProjectDescription()` episode query added to cascade list (Task 9)
- **I4 ACCEPTED:** Cross-process cache staleness is acceptable tradeoff (documented above)
