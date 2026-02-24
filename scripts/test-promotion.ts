#!/usr/bin/env bun
// scripts/test-promotion.ts — Test belief promotion on the test DB

import { Database } from 'bun:sqlite';
import { promoteBeliefs } from '../processor/belief-promoter.js';
import fs from 'node:fs';

const TEST_DB = '/tmp/test-beliefs.db';

if (!fs.existsSync(TEST_DB)) {
  console.error('ERROR: Run scripts/test-beliefs.ts first to generate beliefs');
  process.exit(1);
}

console.log('=== Belief Promotion Test ===\n');

const db = new Database(TEST_DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

// Check current beliefs
const beliefs = db.prepare(`
  SELECT id, SUBSTR(statement, 1, 80) as stmt,
    ROUND(confidence_alpha*1.0/(confidence_alpha+confidence_beta), 2) as conf,
    evidence_count, scope, project_path, promoted_at, demoted_at
  FROM beliefs WHERE status='active'
  ORDER BY confidence_alpha*1.0/(confidence_alpha+confidence_beta) DESC
`).all() as any[];

console.log(`Active beliefs: ${beliefs.length}`);
for (const b of beliefs) {
  console.log(`  ${b.conf} conf, ${b.evidence_count} evidence: ${b.stmt}`);
  console.log(`    project_path: ${b.project_path}, promoted_at: ${b.promoted_at}, demoted_at: ${b.demoted_at}`);
}

console.log('\n--- Running promoteBeliefs() ---\n');

const result = await promoteBeliefs(db);

console.log(`Result: promoted=${result.promoted}, demoted=${result.demoted}, removed=${result.removed}`);

// Check what was written
const memoryPath = `${beliefs[0]?.project_path}/.claude/memory/MEMORY.md`;
console.log(`\nChecking: ${memoryPath}`);
try {
  const content = fs.readFileSync(memoryPath, 'utf-8');
  const lines = content.split('\n');
  // Show the beliefs section
  const beginIdx = lines.findIndex(l => l.includes('ENGRAM:BELIEFS:BEGIN'));
  const endIdx = lines.findIndex(l => l.includes('ENGRAM:BELIEFS:END'));
  if (beginIdx !== -1 && endIdx !== -1) {
    console.log('\n--- BELIEFS SECTION ---');
    for (let i = beginIdx; i <= endIdx; i++) {
      console.log(lines[i]);
    }
    console.log('--- END ---');
    console.log(`\nSection: ${endIdx - beginIdx + 1} lines`);
  } else {
    console.log('No beliefs section found!');
    console.log('File content (first 30 lines):');
    for (const line of lines.slice(0, 30)) {
      console.log(line);
    }
  }
} catch (e) {
  console.log(`File not found: ${(e as Error).message}`);
}

// Check DB updates
const promoted = db.prepare(`SELECT id, promoted_at FROM beliefs WHERE promoted_at IS NOT NULL`).all() as any[];
console.log(`\nBeliefs with promoted_at set: ${promoted.length}`);
for (const p of promoted) {
  console.log(`  ${p.id}: promoted_at=${new Date(p.promoted_at).toISOString()}`);
}

db.close();
console.log('\nDone.');
