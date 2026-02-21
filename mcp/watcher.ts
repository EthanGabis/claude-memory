import chokidar from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import type { EmbeddingProvider } from './providers.js';

/**
 * Discover all .claude/memory/ directories under each project root.
 * Project roots come from CLAUDE_MEMORY_PROJECT_ROOTS env var (default: ~/Desktop/Projects).
 */
export function discoverProjectMemoryDirs(roots?: string[]): string[] {
  const projectRoots = roots ?? (
    (process.env.CLAUDE_MEMORY_PROJECT_ROOTS ?? path.join(os.homedir(), 'Desktop', 'Projects'))
      .split(':')
      .map(r => r.trim())
      .filter(Boolean)
  );

  const result: string[] = [];

  for (const root of projectRoots) {
    try {
      walkForMemoryDirs(root, result, 0, 4);
    } catch {
      // root doesn't exist or isn't readable — skip
    }
  }

  return result;
}

function walkForMemoryDirs(dir: string, result: string[], depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    if (entry.name === 'node_modules' || entry.name === 'venv') continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'memory' && dir.endsWith('.claude')) {
      result.push(full);
    } else {
      walkForMemoryDirs(full, result, depth + 1, maxDepth);
    }
  }
}

/**
 * Determine layer + project name from a file path.
 */
function detectLayerAndProject(filePath: string): { layer: 'global' | 'project'; project?: string } {
  const globalMemDir = path.join(os.homedir(), '.claude-memory');
  if (filePath.startsWith(globalMemDir)) {
    return { layer: 'global' };
  }
  // Project path: find the dir that contains .claude/
  const parts = filePath.split(path.sep);
  const claudeIdx = parts.indexOf('.claude');
  if (claudeIdx > 0) {
    return { layer: 'project', project: parts[claudeIdx - 1] };
  }
  return { layer: 'project' };
}

/**
 * Start the file watcher. Watches global memory dir + all discovered project memory dirs.
 * recentlySaved: Set of paths recently written by memory_save — skip those to avoid double-index.
 */
export function startWatcher(
  db: Database,
  provider: EmbeddingProvider | null,
  recentlySaved: Set<string>,
): void {
  const globalMemDir = path.join(os.homedir(), '.claude-memory');
  const projectMemDirs = discoverProjectMemoryDirs();
  const watchPaths = [
    path.join(globalMemDir, 'MEMORY.md'),
    path.join(globalMemDir, 'memory'),
    ...projectMemDirs,
  ].filter(p => {
    try { fs.statSync(p); return true; } catch { return false; }
  });

  if (watchPaths.length === 0) return;

  const watcher = chokidar.watch(watchPaths, {
    persistent: false,        // don't keep process alive solely for watching
    ignoreInitial: true,      // don't fire for already-existing files at startup
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 100,
    },
    ignored: /[/\\]\./,       // ignore hidden files
  });

  watcher.on('add', handleChange);
  watcher.on('change', handleChange);

  async function handleChange(changedPath: string) {
    if (!changedPath.endsWith('.md')) return;
    if (recentlySaved.has(changedPath)) return; // skip — memory_save already indexed this

    const { layer, project } = detectLayerAndProject(changedPath);

    try {
      // Dynamic import to avoid potential circular dep at module load time
      const { indexFile } = await import('./indexer.js');
      await indexFile(db, changedPath, layer, project, provider ?? undefined);
    } catch (err) {
      console.error('[watcher] re-index failed for', changedPath, (err as Error).message);
    }
  }

  console.error('[watcher] watching', watchPaths.length, 'paths');
}
