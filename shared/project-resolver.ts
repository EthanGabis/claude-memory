import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  name: string | null;       // human-readable basename or null
  isRoot: boolean;            // true if cwd is a project root directory
  fullPath: string | null;    // full path to project directory
}

// Cache resolved project info per JSONL path (only needs to be read once)
const jsonlCache = new Map<string, ProjectInfo>();

/**
 * Resolve project info from a JSONL transcript path.
 * Reads the first entry's `cwd` field, uses path.basename(cwd) as project name.
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
  // C1: Default isRoot to false — prevents cross-project memory leakage when CWD can't be read
  const fallback: ProjectInfo = { name: null, isRoot: false, fullPath: null };

  // W2: FD wrapped in try/finally to prevent leak if readSync/parse throws
  let fd: number | null = null;
  try {
    // W5: Stream until newline (bounded by MAX_FIRST_LINE) instead of fixed-size read.
    // Prevents silent fallback to null when first JSONL line exceeds the read buffer.
    const CHUNK_SIZE = 16384;
    const MAX_FIRST_LINE = 65536; // 64KB safety cap
    fd = fs.openSync(jsonlPath, 'r');

    let accumulated = '';
    let offset = 0;
    let firstLine: string | null = null;

    while (offset < MAX_FIRST_LINE) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      const newlineIdx = accumulated.indexOf('\n');
      if (newlineIdx >= 0) {
        firstLine = accumulated.slice(0, newlineIdx);
        break;
      }
    }

    // If no newline found, use whatever we accumulated (truncated first line)
    if (firstLine === null) firstLine = accumulated;

    if (!firstLine.trim()) return fallback;

    const entry = JSON.parse(firstLine);
    const cwd = entry.cwd;
    if (typeof cwd !== 'string' || !cwd) return fallback;

    const name = path.basename(cwd);
    const isRoot = isProjectRoot(cwd);

    return { name, isRoot, fullPath: cwd };
  } catch {
    return fallback;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
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
