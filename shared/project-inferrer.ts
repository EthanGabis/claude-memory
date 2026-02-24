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
 * Finds the longest common directory prefix, then walks up looking for project markers.
 * Returns null if no project can be inferred (e.g., paths span multiple unrelated trees).
 */
export function inferProjectFromPaths(filePaths: string[], threshold: number = 0.6): ProjectInfo | null {
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

  // Require majority: threshold% of paths should point to this project
  if (bestCount < absolute.length * threshold) return null;

  return {
    name: path.basename(bestRoot),
    isRoot: false,
    fullPath: bestRoot,
  };
}
