# Auto Project Discovery — Implementation Plan

**Date:** 2026-02-23
**Approach:** File-path inference from JSONL tool_use entries, live re-resolution, projects table, startup migration
**Runtime:** Bun/TypeScript
**Schema:** v4 -> v5 (adds `projects` table)

---

## 1. Feature Summary

When Claude Code is launched from a parent directory (e.g., `~/Desktop/Projects`) instead of from within a project (e.g., `~/Desktop/Projects/claude-memory`), all memories go to "global" scope because the `cwd` field points to the parent dir and `CLAUDE_MEMORY_PROJECT_ROOTS` flags it as a root.

**Solution:** Infer the real project from file paths in session transcripts, not just `cwd`.

1. Parse JSONL transcripts for file paths (Read/Edit/Write/Glob/Grep tool calls)
2. Find the common project root from those paths
3. That is the real project -- regardless of where `claude` was launched
4. Auto-create a project entry with a description (from CLAUDE.md if present, otherwise LLM-generated from episode content)
5. Auto-migrate global episodes whose sessions touched that project's files
6. Live re-resolution: if a session starts as root/global but tool calls reveal a specific project mid-session, update project tagging on the fly

---

## 2. Architecture

### Component Overview

```
                         JSONL Transcript
                              |
                    +---------+---------+
                    |                   |
              cwd field            tool_use entries
              (existing)           (NEW: file paths)
                    |                   |
                    v                   v
           resolveFromJsonlSync   extractFilePathsFromEntry()
                    |                   |
                    +--------+----------+
                             |
                   resolveProjectFromJsonlPath()
                   (enhanced: cwd-first, file-path fallback)
                             |
                     +-------+-------+
                     |               |
               At startup       Live (mid-session)
                     |               |
            Startup migration   SessionTailer.processEntry()
            (re-resolve all     (track paths, re-resolve once)
             global episodes)        |
                     |               |
                     v               v
               projects table   UPDATE episodes SET project=?
               (auto-populate)  WHERE session_id=? AND scope='global'
```

### New Files

| File | Purpose |
|------|---------|
| `shared/file-path-extractor.ts` | Extract absolute file paths from JSONL entries and files |
| `shared/project-inferrer.ts` | Infer project from a set of file paths |
| `shared/project-describer.ts` | Generate project descriptions from CLAUDE.md or episodes |

### Modified Files

| File | Change |
|------|--------|
| `shared/project-resolver.ts` | Add file-path fallback when cwd is null/root |
| `processor/session-tailer.ts` | Track file paths, live re-resolution |
| `processor/index.ts` | Startup migration pass, auto-discovery scan |
| `mcp/schema.ts` | v5 migration: `projects` table |

---

## 3. Schema Changes — Projects Table (v5 Migration)

**File:** `mcp/schema.ts`
**Insert after:** Line 271 (after the v4 migration block, before `return db;`)

### SQL

```sql
CREATE TABLE IF NOT EXISTS projects (
  full_path   TEXT PRIMARY KEY,          -- absolute path (e.g. "/Users/.../claude-memory")
  name        TEXT NOT NULL,             -- human-readable name, may not be unique
  description TEXT,                      -- 1-2 sentence auto-generated description
  source      TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'claude_md' | 'manual'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
```

### Migration Code

```typescript
// --- Schema version 5 migration: projects table ---
const v5Row = db.query<{ value: string }, []>(
  `SELECT value FROM _meta WHERE key = 'schema_version'`
).get();
const v5Version = v5Row ? parseInt(v5Row.value, 10) : 1;

if (v5Version < 5) {
  const runV5Migration = () => {
    db.exec(`BEGIN EXCLUSIVE`);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          full_path   TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          source      TEXT NOT NULL DEFAULT 'auto',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

        UPDATE _meta SET value = '5' WHERE key = 'schema_version';
      `);
      db.exec(`COMMIT`);
    } catch (err) {
      try { db.exec(`ROLLBACK`); } catch {}
      throw err;
    }
  };

  try {
    runV5Migration();
  } catch (err) {
    if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
      console.error('[schema] v5 migration busy — retrying in 6s');
      Bun.sleepSync(6000);
      const recheck = db.query<{ value: string }, []>(
        `SELECT value FROM _meta WHERE key = 'schema_version'`
      ).get();
      if (recheck && parseInt(recheck.value, 10) >= 5) {
        console.error('[schema] v5 migration completed by other process');
      } else {
        runV5Migration();
      }
    } else {
      throw err;
    }
  }
}
```

**Placement:** Insert this block at `mcp/schema.ts` between line 271 (`}`) and line 273 (`return db;`). Follows the exact same pattern as v2/v3/v4 migrations.

---

## 4. File-Path Extraction Utility

**New file:** `shared/file-path-extractor.ts`

### Purpose

Extract absolute file paths from JSONL entries. Two modes:
- **Entry mode:** Extract from a single parsed JSONL entry (used by live re-resolution in SessionTailer)
- **File mode:** Scan an entire JSONL file (used by startup migration and enhanced resolver)

### Function Signatures

```typescript
/**
 * Extract absolute file paths from a single parsed JSONL entry.
 * Looks at assistant message content blocks for tool_use entries.
 * Returns an array of absolute paths found.
 */
export function extractFilePathsFromEntry(entry: any): string[];

/**
 * Extract absolute file paths from a JSONL file.
 * Scans up to maxLines entries for tool_use blocks.
 * Also extracts from line 1's file-history-snapshot trackedFileBackups keys.
 * Returns deduplicated array of absolute paths.
 */
export function extractFilePathsFromJsonl(jsonlPath: string, maxLines?: number): string[];
```

### Extraction Rules

**Reliable sources (use these):**

| Tool | Path Location | Always Absolute? |
|------|--------------|-------------------|
| `Read` | `input.file_path` | Yes |
| `Edit` | `input.file_path` | Yes |
| `Write` | `input.file_path` | Yes |
| `Grep` | `input.path` | Yes (file or dir) |
| `Glob` | `input.path` | Usually (defaults to cwd if omitted) |
| `file-history-snapshot` | `snapshot.trackedFileBackups` keys | Yes |

**Skip (too noisy / unreliable):**

| Tool | Reason |
|------|--------|
| `Bash` | Paths embedded in freeform command strings -- regex extraction unreliable |
| `Task` / `SendMessage` | No file paths |
| `WebSearch` / `WebFetch` | URLs, not file paths |
| `NotebookEdit` | `notebook_path` -- could add later but low priority |

### Implementation

```typescript
import fs from 'node:fs';
import path from 'node:path';

const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write']);
const DIR_PATH_TOOLS = new Set(['Grep']);
const GLOB_TOOL = 'Glob';

/**
 * Extract file paths from a single JSONL entry's assistant message content.
 */
export function extractFilePathsFromEntry(entry: any): string[] {
  const paths: string[] = [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return paths;

  for (const block of content) {
    if (block?.type !== 'tool_use' || !block.input) continue;
    const name = block.name;

    // Read/Edit/Write -> input.file_path
    if (FILE_PATH_TOOLS.has(name)) {
      const fp = block.input.file_path;
      if (typeof fp === 'string' && path.isAbsolute(fp)) {
        paths.push(fp);
      }
      continue;
    }

    // Grep -> input.path
    if (DIR_PATH_TOOLS.has(name)) {
      const p = block.input.path;
      if (typeof p === 'string' && path.isAbsolute(p)) {
        paths.push(p);
      }
      continue;
    }

    // Glob -> input.path OR absolute prefix in input.pattern
    if (name === GLOB_TOOL) {
      const p = block.input.path;
      if (typeof p === 'string' && path.isAbsolute(p)) {
        paths.push(p);
      }
      // Also check pattern for absolute prefix (e.g. "/Users/foo/bar/**/*.ts")
      const pattern = block.input.pattern;
      if (typeof pattern === 'string' && path.isAbsolute(pattern)) {
        // Extract the non-glob prefix
        const globStart = pattern.search(/[*?[\{]/);
        if (globStart > 0) {
          const prefix = pattern.slice(0, globStart);
          // Ensure it ends at a directory boundary
          const dirPrefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : prefix;
          if (dirPrefix && path.isAbsolute(dirPrefix)) {
            paths.push(dirPrefix);
          }
        }
      }
      continue;
    }
  }

  return paths;
}

/**
 * Extract file paths from a JSONL file (including file-history-snapshot on line 1).
 * Reads synchronously for use in resolver (which is sync).
 */
export function extractFilePathsFromJsonl(jsonlPath: string, maxLines: number = 200): string[] {
  const allPaths = new Set<string>();

  let fd: number | null = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const CHUNK_SIZE = 16384;
    const MAX_BYTES = 512 * 1024; // 512KB cap
    let accumulated = '';
    let offset = 0;
    let linesScanned = 0;

    while (offset < MAX_BYTES && linesScanned < maxLines) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      let newlineIdx: number;
      while ((newlineIdx = accumulated.indexOf('\n')) >= 0 && linesScanned < maxLines) {
        const line = accumulated.slice(0, newlineIdx);
        accumulated = accumulated.slice(newlineIdx + 1);
        linesScanned++;

        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Line 1: file-history-snapshot -> trackedFileBackups keys
          if (linesScanned === 1 && entry?.type === 'file-history-snapshot') {
            const backups = entry?.snapshot?.trackedFileBackups;
            if (backups && typeof backups === 'object') {
              for (const key of Object.keys(backups)) {
                if (path.isAbsolute(key)) {
                  allPaths.add(key);
                }
              }
            }
            continue;
          }

          // All other lines: extract from tool_use blocks
          const extracted = extractFilePathsFromEntry(entry);
          for (const p of extracted) {
            allPaths.add(p);
          }
        } catch {
          // Malformed line -- skip
        }
      }
    }
  } catch {
    // File read error -- return whatever we have
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return [...allPaths];
}
```

---

## 5. Project Inference from File Paths

**New file:** `shared/project-inferrer.ts`

### Purpose

Given a set of absolute file paths, determine which project they belong to by finding the common root and checking for project markers (`.claude/`, `.git`, `package.json`).

### Function Signature

```typescript
import type { ProjectInfo } from './project-resolver.js';

/**
 * Infer project from a set of absolute file paths.
 * Finds the longest common directory prefix, then walks up looking for project markers.
 * Returns null if no project can be inferred (e.g., paths span multiple unrelated trees).
 */
export function inferProjectFromPaths(paths: string[]): ProjectInfo | null;
```

### Algorithm

```
1. Filter to absolute paths only
2. If < 2 paths, return null (not enough signal)
3. Compute longest common directory prefix (LCP) of all paths
4. If LCP is "/" or a home dir, try majority-vote approach instead
5. Walk up from LCP looking for .claude/ directory (same logic as resolveProjectFromCwd)
6. If found, return { name: basename(projectDir), isRoot: isProjectRoot(projectDir), fullPath: projectDir }
7. If not found, check for .git or package.json as secondary markers
8. Check against CLAUDE_MEMORY_PROJECT_ROOTS -- if project dir is a root, set isRoot=true
9. Handle multi-project edge case: group paths by their closest project root, pick majority
```

### Implementation

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from './project-resolver.js';

/** Project marker directories/files used to detect project roots.
 *  IMPORTANT: Export this constant so runProjectDiscovery in index.ts
 *  can import it instead of maintaining a duplicate list. */
export const PROJECT_MARKERS = ['.claude', '.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];

/**
 * Find the longest common directory prefix of a set of absolute paths.
 */
function longestCommonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '/';
  if (paths.length === 1) return path.dirname(paths[0]);

  const split = paths.map(p => p.split(path.sep));
  const minLen = Math.min(...split.map(s => s.length));
  let common: string[] = [];

  for (let i = 0; i < minLen; i++) {
    const segment = split[0][i];
    if (split.every(s => s[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }

  const result = common.join(path.sep) || '/';
  // If the result points to a file, return its parent directory
  try {
    const stat = fs.statSync(result);
    if (!stat.isDirectory()) return path.dirname(result);
  } catch {
    // Path doesn't exist (file was deleted) -- treat as directory prefix
  }
  return result;
}

/**
 * Walk up from dir looking for project markers. Returns the project dir or null.
 */
function findProjectRoot(dir: string): string | null {
  let current = dir;
  const home = process.env.HOME || '/';

  while (true) {
    // Don't go above home directory
    if (current.length < home.length) return null;

    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(current, marker);
      try {
        fs.statSync(markerPath);
        return current;
      } catch {}
    }

    const parent = path.dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

/**
 * Check if a directory is a project root (listed in CLAUDE_MEMORY_PROJECT_ROOTS).
 */
function isProjectRoot(dir: string): boolean {
  const roots = process.env.CLAUDE_MEMORY_PROJECT_ROOTS;
  if (!roots) return false;
  const normalized = path.resolve(dir);
  return roots.split(':').map(r => r.trim()).filter(Boolean).map(r => path.resolve(r))
    .some(root => normalized === root);
}

/**
 * Infer project from a set of absolute file paths.
 */
export function inferProjectFromPaths(filePaths: string[]): ProjectInfo | null {
  // Filter to absolute paths and normalize
  const absolute = filePaths.filter(p => path.isAbsolute(p)).map(p => path.resolve(p));
  if (absolute.length < 2) return null; // not enough signal

  // Strategy 1: Longest common prefix approach
  const lcp = longestCommonDirPrefix(absolute);

  // If LCP is too shallow (filesystem root, home dir, or a known project root),
  // paths may span multiple projects -- try majority vote instead
  const home = process.env.HOME || '/';
  const isShallow = lcp === '/' || lcp === home || isProjectRoot(lcp);

  if (!isShallow) {
    const projectRoot = findProjectRoot(lcp);
    if (projectRoot) {
      const rootFlag = isProjectRoot(projectRoot);
      if (!rootFlag) {
        return {
          name: path.basename(projectRoot),
          isRoot: false,
          fullPath: projectRoot,
        };
      }
    }
  }

  // Strategy 2: Majority vote -- group paths by their nearest project root
  const projectCounts = new Map<string, number>();
  for (const p of absolute) {
    const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    const root = findProjectRoot(dir);
    if (root && !isProjectRoot(root)) {
      projectCounts.set(root, (projectCounts.get(root) ?? 0) + 1);
    }
  }

  if (projectCounts.size === 0) return null;

  // Pick the project with the most paths
  let bestRoot = '';
  let bestCount = 0;
  for (const [root, count] of projectCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestRoot = root;
    }
  }

  // Require supermajority: more than 60% of paths should point to this project
  if (bestCount < absolute.length * 0.6) return null;

  return {
    name: path.basename(bestRoot),
    isRoot: false,
    fullPath: bestRoot,
  };
}
```

---

## 6. Enhanced Resolver (File-Path Fallback)

**File:** `shared/project-resolver.ts`
**Change:** Modify `resolveFromJsonlSync()` (lines 28-99) to add file-path inference as a fallback

### Current Flow (lines 28-99)

```
1. Read up to 10 lines for cwd field
2. If cwd found: return { name: basename(cwd), isRoot, fullPath: cwd }
3. If not found: return fallback { name: null, isRoot: false, fullPath: null }
```

### New Flow

```
1. Read up to 10 lines for cwd field (unchanged)
2. If cwd found AND is NOT a project root: return as-is (unchanged)
3. If cwd found BUT IS a project root, OR no cwd found:
   a. Call extractFilePathsFromJsonl(jsonlPath, 200)
   b. Call inferProjectFromPaths(paths)
   c. If inference succeeds: return inferred project
   d. If inference fails: return original result (cwd-based or fallback)
```

### Code Changes

**Add imports at top of file (after line 2):**

```typescript
import { extractFilePathsFromJsonl } from './file-path-extractor.js';
import { inferProjectFromPaths } from './project-inferrer.js';
```

**Replace `resolveFromJsonlSync` function (lines 28-99):**

The function body stays the same through line 89 (the existing cwd scanning logic), but instead of returning `fallback` at line 91, we add the file-path inference fallback. The new structure:

```typescript
function resolveFromJsonlSync(jsonlPath: string): ProjectInfo {
  const fallback: ProjectInfo = { name: null, isRoot: false, fullPath: null };

  // --- Phase 1: Existing cwd scan (lines 33-89 unchanged) ---
  let cwdResult: ProjectInfo | null = null;

  let fd: number | null = null;
  try {
    const CHUNK_SIZE = 16384;
    const MAX_FIRST_LINE = 65536;
    const MAX_LINES_TO_SCAN = 10;
    fd = fs.openSync(jsonlPath, 'r');

    let accumulated = '';
    let offset = 0;
    let linesScanned = 0;

    while (offset < MAX_FIRST_LINE && linesScanned < MAX_LINES_TO_SCAN) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      let newlineIdx: number;
      while ((newlineIdx = accumulated.indexOf('\n')) >= 0 && linesScanned < MAX_LINES_TO_SCAN) {
        const line = accumulated.slice(0, newlineIdx);
        accumulated = accumulated.slice(newlineIdx + 1);
        linesScanned++;

        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);
          const cwd = entry.cwd;
          if (typeof cwd === 'string' && cwd) {
            const name = path.basename(cwd);
            const isRoot = isProjectRoot(cwd);
            cwdResult = { name, isRoot, fullPath: cwd };
            break;
          }
        } catch {}
      }
      if (cwdResult) break;
    }

    // Check remaining buffer
    if (!cwdResult && linesScanned < MAX_LINES_TO_SCAN && accumulated.trim()) {
      try {
        const entry = JSON.parse(accumulated);
        const cwd = entry.cwd;
        if (typeof cwd === 'string' && cwd) {
          const name = path.basename(cwd);
          const isRoot = isProjectRoot(cwd);
          cwdResult = { name, isRoot, fullPath: cwd };
        }
      } catch {}
    }
  } catch {
    // File read error
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  // --- Phase 2: File-path inference fallback ---
  // Only invoke if cwd result is null or is a root directory
  if (cwdResult && !cwdResult.isRoot) {
    return cwdResult; // cwd found a specific project -- use it
  }

  // cwd is null or root -- try file-path inference
  try {
    const filePaths = extractFilePathsFromJsonl(jsonlPath, 200);
    if (filePaths.length >= 2) {
      const inferred = inferProjectFromPaths(filePaths);
      if (inferred && !inferred.isRoot) {
        return inferred; // file-path inference found a specific project
      }
    }
  } catch {
    // Inference failed -- fall through
  }

  // Return whatever we had (cwdResult or fallback)
  return cwdResult ?? fallback;
}
```

**Key behavior change:** When `cwd` points to a root directory (e.g., `~/Desktop/Projects`), the resolver now scans tool_use entries for file paths and infers the real project. This is the core fix for the "launched from parent directory" problem.

---

## 7. Live Re-Resolution in SessionTailer

**File:** `processor/session-tailer.ts`

### Overview

Track file paths as assistant messages arrive. After accumulating enough paths, infer the real project. If the current project is null/root and inference finds a specific project, update the tailer's project and re-scope already-extracted episodes.

### Changes

**Add imports (after line 10):**

```typescript
import { extractFilePathsFromEntry } from '../shared/file-path-extractor.js';
import { inferProjectFromPaths } from '../shared/project-inferrer.js';
import { clearProjectCache } from '../shared/project-resolver.js';
```

**Add instance variables (after line 93, inside the class before constructor):**

```typescript
// Live re-resolution state
private observedFilePaths: Set<string> = new Set();
private hasReResolved = false;
private readonly RE_RESOLVE_PATH_THRESHOLD = 5;
```

**Modify `processEntry()` (line 285):**

Insert file-path tracking logic BEFORE the content check. This is critical because `if (!content) return;` at line 291 will bail before reaching any code placed after it, and tool_use-only assistant entries have no text content. The tracking code must run before that early return.

**Insert after line 290 (after role filtering, BEFORE the content check at line 291):**

```typescript
    // --- Live re-resolution: track file paths from tool_use blocks ---
    // IMPORTANT: Must run BEFORE content check -- tool_use-only entries have null content
    if (role === 'assistant' && !this.hasReResolved) {
      const paths = extractFilePathsFromEntry(entry);
      for (const p of paths) this.observedFilePaths.add(p);
      if (this.observedFilePaths.size >= this.RE_RESOLVE_PATH_THRESHOLD) {
        this.attemptReResolution();
      }
    }

    const content = extractContent(entry);
    if (!content) return;
```

**Add new method `attemptReResolution()` (after `processEntry`, around line 356):**

```typescript
  /**
   * Attempt to re-resolve the project from observed file paths.
   * Only upgrades: null/root -> specific project. Never downgrades.
   * Only runs once per session to avoid flip-flopping.
   */
  private attemptReResolution(): void {
    if (this.hasReResolved) return;
    this.hasReResolved = true; // Only try once

    // Only re-resolve if current project is null or root
    if (this.projectName && !this.projectIsRoot) return;

    const inferred = inferProjectFromPaths([...this.observedFilePaths]);
    if (!inferred || !inferred.name || inferred.isRoot) return;

    const oldProject = this.projectName;
    const oldIsRoot = this.projectIsRoot;
    this.projectName = inferred.name;
    this.projectIsRoot = false;

    // Invalidate resolver cache so future reads get the corrected project
    clearProjectCache();

    console.error(
      `[tailer:${this.sessionId.slice(0, 8)}] Re-resolved project: "${oldProject}" (root=${oldIsRoot}) -> "${inferred.name}"`
    );

    // Re-scope already-extracted global episodes from this session
    try {
      const result = this.db.prepare(
        `UPDATE episodes SET project = ?, scope = 'project'
         WHERE session_id = ? AND scope = 'global'`
      ).run(inferred.name, this.sessionId);
      const changes = (result as any).changes ?? 0;
      if (changes > 0) {
        console.error(
          `[tailer:${this.sessionId.slice(0, 8)}] Re-scoped ${changes} episodes to project "${inferred.name}"`
        );
      }
    } catch (err) {
      console.error(
        `[tailer:${this.sessionId.slice(0, 8)}] Re-scope failed: ${(err as Error).message}`
      );
    }
  }
```

### Behavioral Guarantees

- **One-shot:** `hasReResolved` flag ensures re-resolution runs at most once per SessionTailer lifetime. Prevents flip-flopping.
- **Upgrade only:** Only changes from null/root to a specific project. Never downgrades a specific project to root/null.
- **Threshold:** Requires at least 5 distinct file paths before attempting inference. Avoids false positives from a single stray file read.
- **Episode update:** Uses a single SQL UPDATE to re-scope all global episodes for this session. Safe because scope only moves global->project (same direction as the extractor's one-directional override).

---

## 8. Projects Table Auto-Population + Description Generation

### 8a. Project Description Generator

**New file:** `shared/project-describer.ts`

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';

interface ProjectRow {
  name: string;
  full_path: string | null;
  description: string | null;
  source: string;
}

/**
 * Upsert a project into the projects table.
 * If the project already exists, updates full_path and updated_at (but not description/source).
 */
export function upsertProject(
  db: Database,
  name: string,
  fullPath: string | null,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO projects (full_path, name, description, source, created_at, updated_at)
    VALUES (?, ?, NULL, 'auto', ?, ?)
    ON CONFLICT(full_path) DO UPDATE SET
      name = excluded.name,
      updated_at = excluded.updated_at
  `).run(fullPath, name, now, now);
}

/**
 * Generate and store a project description.
 * Priority: 1) CLAUDE.md content, 2) LLM summary from episodes, 3) null
 */
export async function generateProjectDescription(
  projectPath: string,
  projectName: string,
  db: Database,
  openaiClient: any,
): Promise<string | null> {
  // Check if already described (query by full_path, which is the PRIMARY KEY)
  const existing = db.prepare(
    `SELECT description, source FROM projects WHERE full_path = ?`
  ).get(projectPath) as ProjectRow | null;

  if (existing?.description && existing.source !== 'auto') {
    return existing.description; // Manual or CLAUDE.md description -- don't overwrite
  }

  // Strategy 1: Read CLAUDE.md
  const claudeMdPaths = [
    path.join(projectPath, 'CLAUDE.md'),
    path.join(projectPath, '.claude', 'CLAUDE.md'),
  ];

  for (const mdPath of claudeMdPaths) {
    try {
      const content = fs.readFileSync(mdPath, 'utf-8');
      if (content.trim().length > 20) {
        const description = await summarizeWithLlm(
          `Summarize this project in 1-2 sentences based on this CLAUDE.md:\n\n${content.slice(0, 3000)}`,
          openaiClient,
        );
        if (description) {
          const now = Date.now();
          db.prepare(
            `UPDATE projects SET description = ?, source = 'claude_md', updated_at = ? WHERE full_path = ?`
          ).run(description, now, projectPath);
          return description;
        }
      }
    } catch {
      // File not found -- try next
    }
  }

  // Strategy 2: Summarize from recent episodes
  const episodes = db.prepare(`
    SELECT summary FROM episodes
    WHERE project = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(projectName) as { summary: string }[];

  if (episodes.length >= 3) {
    const episodeSummaries = episodes.map(e => `- ${e.summary}`).join('\n');
    const description = await summarizeWithLlm(
      `Based on these memory episodes, describe this project in 1-2 sentences:\n\n${episodeSummaries}`,
      openaiClient,
    );
    if (description) {
      const now = Date.now();
      db.prepare(
        `UPDATE projects SET description = ?, source = 'auto', updated_at = ? WHERE full_path = ?`
      ).run(description, now, projectPath);
      return description;
    }
  }

  return null;
}

/**
 * Call LLM to generate a short summary.
 * Accepts an existing OpenAI client instance (reuse from extractor singleton).
 */
async function summarizeWithLlm(prompt: string, client: any): Promise<string | null> {
  if (!client) return null;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: 'You are a concise technical writer. Respond with 1-2 sentences only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });
    const text = response.choices[0]?.message?.content?.trim();
    return text && text.length > 10 ? text : null;
  } catch {
    return null;
  }
}
```

### 8b. Upsert Projects on Resolution

**File:** `processor/index.ts`
**Change:** After `resolveProjectFromJsonlPath` returns in `startTailer()` (line 251), upsert into projects table.

**Insert after line 251 (`const projectInfo = resolveProjectFromJsonlPath(jsonlPath);`):**

```typescript
  // Auto-populate projects table
  if (projectInfo.name && projectInfo.fullPath && !projectInfo.isRoot) {
    try {
      upsertProject(db, projectInfo.name, projectInfo.fullPath);
    } catch (err) {
      console.error(`[engram] Project upsert failed for "${projectInfo.name}": ${(err as Error).message}`);
    }
  }
```

**Add import at top of file (after line 11):**

```typescript
import { upsertProject } from '../shared/project-describer.js';
```

---

## 9. Startup Migration (Re-Resolve Global Episodes)

**File:** `processor/index.ts`
**Change:** Add a startup migration pass in `main()`, after DB and state are initialized but before tailers start.

**Insert after line 300 (`stateStore.startPeriodicSave();`) and before line 302 (UDS listener):**

```typescript
  // 5.1. Startup migration: re-resolve global episodes using file-path inference
  await runStartupMigration(db);
```

### New Function: `runStartupMigration`

**Add to `processor/index.ts` (after the `startTailer` function, around line 259):**

```typescript
import { extractFilePathsFromJsonl } from '../shared/file-path-extractor.js';
import { inferProjectFromPaths, PROJECT_MARKERS } from '../shared/project-inferrer.js';

/**
 * On startup, re-resolve all global episodes whose sessions might belong to a project.
 * Scans JSONL files for file paths and infers the real project.
 * Runs once per startup -- safe to repeat (idempotent).
 */
async function runStartupMigration(database: Database): Promise<void> {
  console.error('[engram] Running startup migration: re-resolving global episodes...');

  // Step 1: Get all session_ids that have global episodes
  const globalSessions = database.prepare(`
    SELECT DISTINCT session_id FROM episodes WHERE scope = 'global'
  `).all() as { session_id: string }[];

  if (globalSessions.length === 0) {
    console.error('[engram] No global episodes to re-resolve');
    return;
  }

  console.error(`[engram] Found ${globalSessions.length} sessions with global episodes`);

  // Step 2: Build session -> JSONL path mapping
  const sessionToJsonl = new Map<string, string>();
  try {
    const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectEntries) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(PROJECTS_DIR, projectDir.name);
      try {
        const files = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.name.endsWith('.jsonl') || !file.isFile()) continue;
          const sessionId = path.basename(file.name, '.jsonl');
          sessionToJsonl.set(sessionId, path.join(projectPath, file.name));
        }
      } catch {}
    }
  } catch {}

  // Step 3: For each global session, try file-path inference
  let rescoped = 0;
  let projectsDiscovered = 0;

  const updateStmt = database.prepare(
    `UPDATE episodes SET scope = 'project', project = ? WHERE session_id = ? AND scope = 'global'`
  );

  // Batch updates in groups of 20 sessions per transaction to avoid holding
  // the WAL lock for too long on large databases
  const BATCH_SIZE = 20;
  for (let i = 0; i < globalSessions.length; i += BATCH_SIZE) {
    const batch = globalSessions.slice(i, i + BATCH_SIZE);
    database.exec('BEGIN TRANSACTION');
    try {
      for (const { session_id } of batch) {
        const jsonlPath = sessionToJsonl.get(session_id);
        if (!jsonlPath) continue;

        try {
          const filePaths = extractFilePathsFromJsonl(jsonlPath, 200);
          if (filePaths.length < 2) continue;

          const inferred = inferProjectFromPaths(filePaths);
          if (!inferred || !inferred.name || inferred.isRoot) continue;

          const result = updateStmt.run(inferred.name, session_id);
          const changes = (result as any).changes ?? 0;
          rescoped += changes;

          // Upsert into projects table
          if (inferred.fullPath) {
            upsertProject(database, inferred.name, inferred.fullPath);
            projectsDiscovered++;
          }
        } catch {}
      }

      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch {}
      console.error(`[engram] Startup migration batch failed (sessions ${i}-${i + batch.length}): ${(err as Error).message}`);
      // Continue with next batch instead of aborting entirely
    }
  }

  console.error(`[engram] Startup migration: ${rescoped} episodes re-scoped, ${projectsDiscovered} projects discovered`);
}
```

### Filesystem Auto-Discovery

**Also in startup, after migration (optional, lower priority):**

```typescript
  // 5.2. Auto-discover projects from filesystem
  await runProjectDiscovery(db);
```

```typescript
/**
 * Scan CLAUDE_MEMORY_PROJECT_ROOTS for subdirectories that look like projects.
 * Upsert them into the projects table.
 */
async function runProjectDiscovery(database: Database): Promise<void> {
  const roots = process.env.CLAUDE_MEMORY_PROJECT_ROOTS;
  if (!roots) return;

  let discovered = 0;
  for (const root of roots.split(':').map(r => r.trim()).filter(Boolean)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // skip hidden dirs

        const dirPath = path.join(root, entry.name);

        // Check for project markers (imported from project-inferrer.ts)
        const isProject = PROJECT_MARKERS.some(m => {
          try { fs.statSync(path.join(dirPath, m)); return true; } catch { return false; }
        });

        if (isProject) {
          upsertProject(database, entry.name, dirPath);
          discovered++;
        }
      }
    } catch {}
  }

  if (discovered > 0) {
    console.error(`[engram] Auto-discovered ${discovered} projects from filesystem`);
  }
}
```

---

## 10. Files to Create/Modify

| File | Action | Lines Changed | Description |
|------|--------|---------------|-------------|
| `shared/file-path-extractor.ts` | **CREATE** | ~130 new | Extract file paths from JSONL entries and files |
| `shared/project-inferrer.ts` | **CREATE** | ~120 new | Infer project from file paths via LCP + marker walk |
| `shared/project-describer.ts` | **CREATE** | ~120 new | Generate project descriptions, upsert into projects table |
| `shared/project-resolver.ts` | **MODIFY** | Replace lines 28-99 | Add file-path inference fallback after cwd scan |
| `processor/session-tailer.ts` | **MODIFY** | +40 lines | Add file path tracking + live re-resolution |
| `processor/index.ts` | **MODIFY** | +80 lines | Startup migration, project upsert, auto-discovery |
| `mcp/schema.ts` | **MODIFY** | +40 lines (after L271) | v5 migration: projects table |

### Estimated Total

- **New code:** ~370 lines across 3 new files
- **Modified code:** ~160 lines across 4 existing files
- **Total:** ~530 lines

---

## 11. Task Breakdown (Ordered, with Dependencies)

```
Task 1: Create shared/file-path-extractor.ts
  - No dependencies
  - Deliverable: extractFilePathsFromEntry(), extractFilePathsFromJsonl()
  - Test: Unit test with mock JSONL entries

Task 2: Create shared/project-inferrer.ts
  - No dependencies
  - Deliverable: inferProjectFromPaths()
  - Test: Unit test with known path sets -> expected project

Task 3: Add projects table to mcp/schema.ts (v5 migration)
  - No dependencies
  - Deliverable: projects table created on initDb()
  - Test: Run initDb(), verify table exists, verify schema_version=5

Task 4: Enhance shared/project-resolver.ts (file-path fallback)
  - Depends on: Task 1, Task 2
  - Deliverable: resolveFromJsonlSync() uses file-path inference when cwd is root
  - Test: JSONL with root cwd + tool_use paths -> returns specific project

Task 5: Create shared/project-describer.ts
  - Depends on: Task 3
  - Deliverable: upsertProject(), generateProjectDescription()
  - Test: Upsert project, verify row in DB. Description from CLAUDE.md.

Task 6: Modify processor/session-tailer.ts (live re-resolution)
  - Depends on: Task 1, Task 2, Task 3
  - Deliverable: File path tracking + attemptReResolution() + episode re-scoping
  - Test: SessionTailer with root project processes entries with file paths -> project updated

Task 7: Modify processor/index.ts (startup migration + auto-discovery)
  - Depends on: Task 1, Task 2, Task 3, Task 5
  - Deliverable: runStartupMigration(), runProjectDiscovery(), project upsert in startTailer()
  - Test: Seed global episodes, run startup migration, verify re-scoped
```

### Dependency Graph

```
  Task 1 ─────┐
              ├── Task 4 ──┐
  Task 2 ─────┘            │
                            ├── Task 6
  Task 3 ──── Task 5 ──────┤
                            └── Task 7
```

Tasks 1, 2, 3 can be done in parallel. Task 4 depends on 1+2. Task 5 depends on 3. Tasks 6 and 7 depend on everything above.

---

## 12. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Performance: scanning 200 lines per JSONL on startup** | Medium | Cap at 512KB, use sync I/O (already pattern in codebase). Startup migration is one-time per boot. |
| **False positive project inference** | Medium | Require 2+ file paths, 60% supermajority vote, `.claude/` marker preference. Only upgrade null/root -> project, never downgrade. |
| **Multi-project sessions** | Low | Majority vote picks the dominant project. Edge case: user switches between projects in one session. Acceptable loss -- better than "global" for all. |
| **LLM cost for descriptions** | Low | gpt-4.1-nano is cheap (~$0.001/call). Descriptions generated only once per project (cached in DB). |
| **Schema migration (v5) on busy DB** | Low | Same retry-with-backoff pattern as v2/v3/v4. 6s sleep + recheck. |
| **Live re-resolution race with extraction** | Medium | `attemptReResolution()` runs synchronously in the `processEntry()` path, before extraction triggers. Re-scope SQL is a single atomic UPDATE. Extraction dedup handles duplicates. |
| **File-path extractor missing new tools** | Low | Only tool_use blocks with known names are parsed. New tools silently ignored. Easy to add later. |
| **Startup migration slow on large DBs** | Medium | Batched in groups of 20 sessions per transaction to avoid long WAL locks. JSONL scanning is I/O bound but capped. Log progress for observability. |

---

## 13. Rollback Plan

### Database

The v5 migration only adds a new `projects` table -- it does not modify existing tables. Rollback:

```sql
DROP TABLE IF EXISTS projects;
UPDATE _meta SET value = '4' WHERE key = 'schema_version';
```

No data loss -- the projects table is purely additive metadata.

### Episode Re-Scoping

If episodes are incorrectly re-scoped by startup migration or live re-resolution:

```sql
-- Revert all auto-re-scoped episodes back to global
UPDATE episodes SET scope = 'global', project = NULL
WHERE scope = 'project'
  AND session_id IN (
    SELECT DISTINCT session_id FROM episodes
    WHERE -- identify sessions that were re-scoped
  );
```

Or use the existing `scripts/migrate-project-scoping.ts` pattern: it builds a session->project mapping from JSONL files and re-scopes in a transaction.

### Code Rollback

All new files can be deleted, all modified files can be reverted. The v5 migration is forward-only in the schema but the table can be dropped manually. No other tables are touched.

### Feature Flag (Optional)

Add `ENGRAM_DISABLE_AUTO_DISCOVERY=1` environment variable to skip:
- File-path inference in resolver (use cwd-only, existing behavior)
- Live re-resolution in SessionTailer
- Startup migration
- Project auto-discovery

This would be a low-cost safety valve during rollout.

---

## 14. Review Fixes Applied

### Critical Fixes

| ID | Fix | Section |
|----|-----|---------|
| **C1** | `processEntry` file-path extraction moved BEFORE `if (!content) return;` check -- tool_use-only assistant entries have null content and would bail before reaching the tracking code | Section 7 |
| **C2** | Added `clearProjectCache()` call after re-resolution updates the project name, so future reads from the resolver cache get the corrected project | Section 7 |
| **C3** | Captured `oldProject` and `oldIsRoot` before mutating `this.projectName`/`this.projectIsRoot`, so the log line references the stale values correctly instead of the already-updated ones | Section 7 |

### Important Fixes

| ID | Fix | Section |
|----|-----|---------|
| **I3** | Raised majority-vote threshold from 50% to 60% to reduce false-positive project inference | Section 5 |
| **I4** | Startup migration batches transactions in groups of 20 sessions instead of one giant transaction, avoiding long WAL lock holds on large databases | Section 9 |
| **I6** | `summarizeWithLlm` accepts an OpenAI client instance instead of creating one -- caller passes the existing client from the extractor singleton | Section 8a |
| **I8** | Changed `projects` table PRIMARY KEY from `name` to `full_path` to avoid collisions when multiple projects share a name; added `idx_projects_name` index; updated all upsert/query SQL to use `full_path` as conflict target | Sections 3, 8a |
| **I9** | Exported `PROJECT_MARKERS` from `project-inferrer.ts` and imported it in `runProjectDiscovery` (index.ts) to keep marker lists in sync | Sections 5, 9 |

---

## Appendix A: JSONL Entry Structure Reference

### User message entry
```json
{
  "type": "user",
  "cwd": "/Users/ethangabis/Desktop/Projects",
  "sessionId": "abc123",
  "message": {
    "role": "user",
    "content": "Fix the bug in the memory system"
  },
  "timestamp": "2026-02-23T12:00:00Z"
}
```

### Assistant message entry with tool_use
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Let me read the file." },
      {
        "type": "tool_use",
        "name": "Read",
        "input": {
          "file_path": "/Users/ethangabis/Desktop/Projects/claude-memory/mcp/schema.ts"
        }
      }
    ]
  },
  "timestamp": "2026-02-23T12:00:05Z"
}
```

### file-history-snapshot (line 1)
```json
{
  "type": "file-history-snapshot",
  "snapshot": {
    "trackedFileBackups": {
      "/Users/ethangabis/Desktop/Projects/claude-memory/mcp/schema.ts": "...",
      "/Users/ethangabis/Desktop/Projects/claude-memory/processor/index.ts": "..."
    }
  }
}
```

## Appendix B: Existing Code References

| Symbol | File | Line |
|--------|------|------|
| `ProjectInfo` interface | `shared/project-resolver.ts` | 4-8 |
| `resolveProjectFromJsonlPath()` | `shared/project-resolver.ts` | 19-26 |
| `resolveFromJsonlSync()` | `shared/project-resolver.ts` | 28-99 |
| `resolveProjectFromCwd()` | `shared/project-resolver.ts` | 105-134 |
| `isProjectRoot()` | `shared/project-resolver.ts` | 140-152 |
| `SessionTailer` class | `processor/session-tailer.ts` | 66-576 |
| `SessionTailer.constructor()` | `processor/session-tailer.ts` | 98-126 |
| `SessionTailer.processEntry()` | `processor/session-tailer.ts` | 285-356 |
| `SessionTailer.extract()` | `processor/session-tailer.ts` | 358-523 |
| `startTailer()` | `processor/index.ts` | 229-259 |
| `main()` | `processor/index.ts` | 264-461 |
| `discoverSessions()` | `processor/index.ts` | 101-142 |
| `initDb()` | `mcp/schema.ts` | 6-274 |
| `v4 migration ends` | `mcp/schema.ts` | 271 |
| `upsertEpisode()` | `processor/extractor.ts` | 228-331 |
| `fetchEpisodeSnapshot()` | `processor/extractor.ts` | 160-181 |
| `extractMemories()` | `processor/extractor.ts` | 73-139 |
| `CandidateMemory` interface | `processor/extractor.ts` | 10-16 |
| `SessionState` interface | `processor/state.ts` | 9-17 |
| `StateStore` class | `processor/state.ts` | 25-158 |
| `SOCKET_PATH` | `shared/uds.ts` | 6 |
| `migrate-project-scoping.ts` | `scripts/migrate-project-scoping.ts` | 1-123 |
