/**
 * Migration script: Re-scope misclassified episodes.
 *
 * Fixes three failure modes:
 *   A) Episodes from project sessions incorrectly scoped as "global"
 *   B) Episodes tagged with project="Projects" (root dir, should be global)
 *
 * Usage: bun scripts/migrate-project-scoping.ts
 */

import { resolveProjectFromJsonlPath } from '../shared/project-resolver.js';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Glob } from 'bun';

// Set the env var so isRoot works during migration
process.env.CLAUDE_MEMORY_PROJECT_ROOTS = '/Users/ethangabis/Desktop/Projects:/Users/ethangabis';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DB_PATH = path.join(os.homedir(), '.claude-memory', 'memory.db');

// ---------------------------------------------------------------------------
// Step 1: Build session → project mapping from all JSONL files
// ---------------------------------------------------------------------------

console.log('=== Step 1: Building session → project mapping ===');

const sessionMap = new Map<string, { name: string | null; isRoot: boolean }>();

const glob = new Glob('*/*.jsonl');
for (const relPath of glob.scanSync({ cwd: PROJECTS_DIR, absolute: false })) {
  const fullPath = path.join(PROJECTS_DIR, relPath);
  const sessionId = path.basename(relPath, '.jsonl');

  const info = resolveProjectFromJsonlPath(fullPath);
  sessionMap.set(sessionId, { name: info.name, isRoot: info.isRoot });
}

console.log(`Sessions mapped: ${sessionMap.size}`);

// Print a sample of project assignments for sanity check
const projectCounts = new Map<string, number>();
for (const [, info] of sessionMap) {
  const key = info.isRoot ? '(root)' : (info.name ?? '(null)');
  projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
}
console.log('Session breakdown:');
for (const [proj, count] of [...projectCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${proj}: ${count} sessions`);
}

// ---------------------------------------------------------------------------
// Step 2: Re-scope global episodes
// ---------------------------------------------------------------------------

console.log('\n=== Step 2: Re-scoping global episodes ===');

const db = new Database(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

const globalEpisodes = db
  .query<{ id: string; session_id: string }, []>('SELECT id, session_id FROM episodes WHERE scope = \'global\'')
  .all();

console.log(`Global episodes found: ${globalEpisodes.length}`);

const rescopeByProject = new Map<string, number>();
let leftAsGlobal = 0;

const updateStmt = db.prepare('UPDATE episodes SET scope = ?, project = ? WHERE id = ?');

db.exec('BEGIN TRANSACTION');

for (const ep of globalEpisodes) {
  const mapping = sessionMap.get(ep.session_id);

  if (mapping && mapping.name && !mapping.isRoot) {
    updateStmt.run('project', mapping.name, ep.id);
    rescopeByProject.set(mapping.name, (rescopeByProject.get(mapping.name) ?? 0) + 1);
  } else {
    leftAsGlobal++;
  }
}

// ---------------------------------------------------------------------------
// Step 3: Fix "Projects" episodes
// ---------------------------------------------------------------------------

console.log('\n=== Step 3: Fixing "Projects" episodes ===');

const projectsEpisodes = db
  .query<{ id: string }, []>('SELECT id FROM episodes WHERE project = \'Projects\'')
  .all();

console.log(`"Projects" episodes found: ${projectsEpisodes.length}`);

const fixProjectsStmt = db.prepare('UPDATE episodes SET scope = \'global\', project = NULL WHERE id = ?');
for (const ep of projectsEpisodes) {
  fixProjectsStmt.run(ep.id);
}

db.exec('COMMIT');
db.close();

// ---------------------------------------------------------------------------
// Step 4: Report
// ---------------------------------------------------------------------------

const totalRescoped = [...rescopeByProject.values()].reduce((a, b) => a + b, 0);

console.log('\n=== Migration Report ===');
console.log(`Sessions mapped: ${sessionMap.size}`);
console.log(`Global episodes found: ${globalEpisodes.length}`);
console.log(`Re-scoped to project: ${totalRescoped}`);
for (const [proj, count] of [...rescopeByProject.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${proj}: ${count}`);
}
console.log(`Left as global: ${leftAsGlobal}`);
console.log(`"Projects" episodes fixed: ${projectsEpisodes.length}`);
console.log('\nMigration complete.');
