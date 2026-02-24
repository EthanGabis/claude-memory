#!/usr/bin/env bun
// scripts/test-beliefs.ts — One-off test of the belief consolidation pipeline
//
// Usage: bun run scripts/test-beliefs.ts
//
// Copies the production DB to /tmp, filters to only claude-memory episodes,
// resets the consolidation checkpoint, runs belief consolidation, and reports results.

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROD_DB = path.join(os.homedir(), '.claude-memory', 'memory.db');
const TEST_DB = '/tmp/test-beliefs.db';
const PROJECT_FILTER = 'claude-memory';

// ---------------------------------------------------------------------------
// 1. Copy DB to temp location
// ---------------------------------------------------------------------------

console.log('=== Belief Consolidation Test ===\n');

if (!fs.existsSync(PROD_DB)) {
  console.error(`ERROR: Production DB not found at ${PROD_DB}`);
  process.exit(1);
}

console.log(`[1/6] Copying DB from ${PROD_DB} to ${TEST_DB} ...`);

// Remove old test DB if it exists (also WAL/SHM files)
for (const suffix of ['', '-wal', '-shm']) {
  const f = TEST_DB + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

fs.copyFileSync(PROD_DB, TEST_DB);
// Also copy WAL if present so we get the latest data
const walPath = PROD_DB + '-wal';
if (fs.existsSync(walPath)) {
  fs.copyFileSync(walPath, TEST_DB + '-wal');
}
console.log('   Done.\n');

// ---------------------------------------------------------------------------
// 2. Open copied DB and filter episodes
// ---------------------------------------------------------------------------

console.log(`[2/6] Filtering episodes to project="${PROJECT_FILTER}" ...`);

const db = new Database(TEST_DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

const totalBefore = (db.query<{ cnt: number }, []>('SELECT count(*) as cnt FROM episodes').get())!.cnt;
console.log(`   Total episodes before filter: ${totalBefore}`);

// Delete episodes NOT in the target project
db.prepare(`DELETE FROM episodes WHERE project != ? OR project IS NULL`).run(PROJECT_FILTER);

const totalAfter = (db.query<{ cnt: number }, []>('SELECT count(*) as cnt FROM episodes').get())!.cnt;
console.log(`   Episodes after filter (project="${PROJECT_FILTER}"): ${totalAfter}`);

if (totalAfter === 0) {
  console.error(`\nERROR: No episodes found for project "${PROJECT_FILTER}". Nothing to consolidate.`);
  process.exit(1);
}

// Show how many have embeddings
const withEmbeddings = (db.query<{ cnt: number }, []>(
  'SELECT count(*) as cnt FROM episodes WHERE embedding IS NOT NULL'
).get())!.cnt;
console.log(`   Episodes with embeddings: ${withEmbeddings}`);
console.log();

// ---------------------------------------------------------------------------
// 3. Reset consolidation checkpoint to 0
// ---------------------------------------------------------------------------

console.log('[3/6] Resetting belief_consolidation_checkpoint to 0 ...');
db.exec(`UPDATE _meta SET value = '0' WHERE key = 'belief_consolidation_checkpoint'`);

// Also clear any existing beliefs so we start fresh
const existingBeliefs = (db.query<{ cnt: number }, []>(
  'SELECT count(*) as cnt FROM beliefs'
).get())!.cnt;
if (existingBeliefs > 0) {
  console.log(`   Clearing ${existingBeliefs} existing beliefs for clean test ...`);
  db.exec('DELETE FROM beliefs');
}
console.log('   Done.\n');

// Close the raw DB handle — initDb will reopen with full schema migrations
db.close();

// ---------------------------------------------------------------------------
// 4. Initialize dependencies
// ---------------------------------------------------------------------------

console.log('[4/6] Initializing dependencies ...');

// Import project modules
const { initDb } = await import('../mcp/schema.js');
const { LocalGGUFProvider } = await import('../mcp/providers.js');
const { runBeliefConsolidation } = await import('../processor/belief-consolidator.js');

// Re-open with initDb (runs migrations, sets pragmas)
const testDb = initDb(TEST_DB);
console.log('   Database opened with initDb');

// OpenAI client
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}
const { default: OpenAI } = await import('openai');
const openai = new OpenAI({ apiKey });
console.log('   OpenAI client created');

// Embedding provider — try local GGUF first, fall back to simple OpenAI wrapper
let embedProvider: { embed(texts: string[]): Promise<(Float32Array | null)[]> };
try {
  console.log('   Loading local GGUF embedding model ...');
  const gguf = new LocalGGUFProvider();
  // Warm up to verify it works
  await gguf.embed(['warmup test']);
  embedProvider = gguf;
  console.log('   LocalGGUFProvider ready');
} catch (err) {
  console.log(`   GGUF load failed: ${(err as Error).message}`);
  console.log('   Falling back to OpenAI embeddings ...');

  // Simple OpenAI-based embed provider as fallback
  embedProvider = {
    async embed(texts: string[]): Promise<(Float32Array | null)[]> {
      if (texts.length === 0) return [];
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
        dimensions: 768,
        encoding_format: 'float',
      });
      return res.data.map((d) => new Float32Array(d.embedding));
    },
  };
  console.log('   OpenAI embed fallback ready');
}
console.log();

// ---------------------------------------------------------------------------
// 5. Run consolidation
// ---------------------------------------------------------------------------

console.log('[5/6] Running belief consolidation ...');
console.log('   (LLM calls will be logged to stderr)\n');

const startTime = Date.now();
try {
  await runBeliefConsolidation(testDb, openai, embedProvider);
} catch (err) {
  console.error(`\nERROR during consolidation: ${(err as Error).message}`);
  console.error((err as Error).stack);
}
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n   Consolidation completed in ${elapsed}s\n`);

// ---------------------------------------------------------------------------
// 6. Report results
// ---------------------------------------------------------------------------

console.log('[6/6] Results:\n');

interface BeliefRow {
  id: string;
  statement: string;
  confidence_alpha: number;
  confidence_beta: number;
  scope: string;
  project: string | null;
  evidence_count: number;
  status: string;
  subject: string | null;
  predicate: string | null;
  context: string | null;
  supporting_episodes: string;
  contradicting_episodes: string;
  created_at: number;
}

const beliefs = testDb.query<BeliefRow, []>(`
  SELECT id, statement, confidence_alpha, confidence_beta, scope, project,
         evidence_count, status, subject, predicate, context,
         supporting_episodes, contradicting_episodes, created_at
  FROM beliefs
  ORDER BY created_at ASC
`).all();

console.log(`Total beliefs created: ${beliefs.length}\n`);

if (beliefs.length === 0) {
  console.log('No beliefs were created. Possible reasons:');
  console.log(`  - Need at least ${20} episodes with embeddings (have ${withEmbeddings})`);
  console.log('  - Episodes may not form clusters of 3+ similar items');
  console.log('  - Check stderr output above for consolidator logs');
} else {
  for (let i = 0; i < beliefs.length; i++) {
    const b = beliefs[i];
    const confidence = (b.confidence_alpha / (b.confidence_alpha + b.confidence_beta)).toFixed(3);
    const supporting = JSON.parse(b.supporting_episodes).length;
    const contradicting = JSON.parse(b.contradicting_episodes).length;

    console.log(`--- Belief ${i + 1} ---`);
    console.log(`  ID:          ${b.id}`);
    console.log(`  Statement:   ${b.statement}`);
    console.log(`  Subject:     ${b.subject ?? '(none)'}`);
    console.log(`  Predicate:   ${b.predicate ?? '(none)'}`);
    console.log(`  Context:     ${b.context ?? '(none)'}`);
    console.log(`  Confidence:  ${confidence} (alpha=${b.confidence_alpha}, beta=${b.confidence_beta})`);
    console.log(`  Scope:       ${b.scope}`);
    console.log(`  Project:     ${b.project ?? '(none)'}`);
    console.log(`  Evidence:    ${b.evidence_count} (${supporting} supporting, ${contradicting} contradicting)`);
    console.log(`  Status:      ${b.status}`);
    console.log(`  Created:     ${new Date(b.created_at).toISOString()}`);
    console.log();
  }
}

// Final checkpoint value
const finalCheckpoint = testDb.query<{ value: string }, []>(
  `SELECT value FROM _meta WHERE key = 'belief_consolidation_checkpoint'`
).get();
console.log(`Final checkpoint: ${finalCheckpoint?.value ?? 'not set'}`);

// Cleanup
testDb.close();
console.log(`\nTest DB preserved at ${TEST_DB} for inspection.`);
console.log('Done.');
