import fs from 'node:fs';
import path from 'node:path';
import { extractFilePathsFromJsonl } from './file-path-extractor.js';
import { inferProjectFromPaths } from './project-inferrer.js';

export interface ProjectInfo {
  name: string | null;       // human-readable basename or null
  isRoot: boolean;            // true if cwd is a project root directory
  fullPath: string | null;    // full path to project directory
}

// Cache resolved project info per JSONL path (only needs to be read once)
const jsonlCache = new Map<string, ProjectInfo>();

/**
 * Resolve project info from a JSONL transcript path.
 * Scans up to the first 10 entries for a `cwd` field, uses path.basename(cwd) as project name.
 * Checks CLAUDE_MEMORY_PROJECT_ROOTS env var for isRoot detection.
 * Result is cached per JSONL path.
 */
export function resolveProjectFromJsonlPath(jsonlPath: string): ProjectInfo {
  const cached = jsonlCache.get(jsonlPath);
  if (cached) return cached;

  const result = resolveFromJsonlSync(jsonlPath);
  jsonlCache.set(jsonlPath, result);
  return result;
}

function resolveFromJsonlSync(jsonlPath: string): ProjectInfo {
  const fallback: ProjectInfo = { name: null, isRoot: false, fullPath: null };

  // --- Phase 1: Existing cwd scan ---
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

/**
 * Resolve project info from a working directory.
 * Used by MCP server. Walks up from cwd looking for .claude/ directory.
 */
export function resolveProjectFromCwd(cwd: string): ProjectInfo {
  const isRoot = isProjectRoot(cwd);

  // Walk up looking for .claude/ directory to find project boundary
  let dir = cwd;
  while (true) {
    const claudeDir = path.join(dir, '.claude');
    try {
      const stat = fs.statSync(claudeDir);
      if (stat.isDirectory()) {
        return {
          name: path.basename(dir),
          isRoot,
          fullPath: dir,
        };
      }
    } catch {}

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // No .claude/ found -- use cwd basename
  return {
    name: path.basename(cwd),
    isRoot,
    fullPath: cwd,
  };
}

/**
 * Check if the given directory is a project root.
 * A project root is a directory listed in CLAUDE_MEMORY_PROJECT_ROOTS env var.
 */
function isProjectRoot(cwd: string): boolean {
  const roots = process.env.CLAUDE_MEMORY_PROJECT_ROOTS;
  if (!roots) return false;

  const normalizedCwd = path.resolve(cwd);
  // W4: Filter empty entries before resolving — prevents path.resolve('') returning CWD
  return roots
    .split(':')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r))
    .some((root) => normalizedCwd === root);
}

/**
 * Clear the JSONL cache (useful for testing).
 */
export function clearProjectCache(): void {
  jsonlCache.clear();
}
