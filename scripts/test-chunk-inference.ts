#!/usr/bin/env bun
// scripts/test-chunk-inference.ts — Unit test for per-chunk project inference
//
// Usage: bun run scripts/test-chunk-inference.ts
//
// Tests inferProjectFromPaths() with realistic file paths to verify that
// per-chunk project inference correctly identifies child projects when a
// session is launched from a parent/root directory like /Desktop/Projects.

import { inferProjectFromPaths } from '../shared/project-inferrer.js';

// ---------------------------------------------------------------------------
// Setup: Set CLAUDE_MEMORY_PROJECT_ROOTS so /Desktop/Projects is recognized
// as a root directory (this is what the daemon sets in production).
// ---------------------------------------------------------------------------

const PROJECTS_DIR = '/Users/ethangabis/Desktop/Projects';
process.env.CLAUDE_MEMORY_PROJECT_ROOTS = PROJECTS_DIR;

let passed = 0;
let failed = 0;

function assert(
  testName: string,
  actual: { name: string | null; fullPath: string | null; isRoot: boolean } | null,
  expected: { name: string | null; fullPath: string | null; isRoot: boolean } | null,
): void {
  const ok =
    actual?.name === expected?.name &&
    actual?.fullPath === expected?.fullPath &&
    actual?.isRoot === expected?.isRoot;

  if (ok) {
    console.log(`  PASS  ${testName}`);
    passed++;
  } else {
    console.log(`  FAIL  ${testName}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertNull(testName: string, actual: any): void {
  if (actual === null) {
    console.log(`  PASS  ${testName}`);
    passed++;
  } else {
    console.log(`  FAIL  ${testName} — expected null, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('=== Per-Chunk Project Inference Tests ===\n');

// Test 1: All paths within TrueTTS → should infer TrueTTS
console.log('Test 1: TrueTTS file paths');
const truettsResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/routers/tts.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/voice.py',
]);
assert('TrueTTS inferred correctly', truettsResult, {
  name: 'TrueTTS',
  fullPath: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS',
  isRoot: false,
});

// Test 2: All paths within claude-memory → should infer claude-memory
console.log('\nTest 2: claude-memory file paths');
const memoryResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/claude-memory/processor/session-tailer.ts',
  '/Users/ethangabis/Desktop/Projects/claude-memory/mcp/server.ts',
  '/Users/ethangabis/Desktop/Projects/claude-memory/shared/project-inferrer.ts',
]);
assert('claude-memory inferred correctly', memoryResult, {
  name: 'claude-memory',
  fullPath: '/Users/ethangabis/Desktop/Projects/claude-memory',
  isRoot: false,
});

// Test 3: All paths within MM → should infer MM
console.log('\nTest 3: MM file paths');
const mmResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/MM/src/backend/main.py',
  '/Users/ethangabis/Desktop/Projects/MM/src/frontend/app.tsx',
  '/Users/ethangabis/Desktop/Projects/MM/docker-compose.yml',
]);
assert('MM inferred correctly', mmResult, {
  name: 'MM',
  fullPath: '/Users/ethangabis/Desktop/Projects/MM',
  isRoot: false,
});

// Test 4: Mixed paths (TrueTTS + claude-memory) → should return null
// because no single project has >= 60% of paths
console.log('\nTest 4: Mixed paths (50/50 split, below threshold)');
const mixedResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/routers/tts.py',
  '/Users/ethangabis/Desktop/Projects/claude-memory/processor/session-tailer.ts',
  '/Users/ethangabis/Desktop/Projects/claude-memory/mcp/server.ts',
]);
// LCP = /Users/ethangabis/Desktop/Projects → findProjectRoot finds Projects
// But Projects is in CLAUDE_MEMORY_PROJECT_ROOTS, so isShallow=true → falls
// through to majority vote. 2/4 TrueTTS, 2/4 claude-memory → neither >= 60%.
assertNull('Mixed paths returns null', mixedResult);

// Test 5: Single file path → not enough signal, should return null
console.log('\nTest 5: Single file path (< 2 paths)');
const singleResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
]);
assertNull('Single path returns null', singleResult);

// Test 6: Empty paths → should return null
console.log('\nTest 6: Empty file paths');
const emptyResult = inferProjectFromPaths([]);
assertNull('Empty paths returns null', emptyResult);

// Test 7: Majority vote — 3 TrueTTS + 1 claude-memory (75% → above threshold)
console.log('\nTest 7: Majority vote (75% TrueTTS, above threshold)');
const majorityResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/routers/tts.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/voice.py',
  '/Users/ethangabis/Desktop/Projects/claude-memory/processor/session-tailer.ts',
]);
assert('Majority vote picks TrueTTS', majorityResult, {
  name: 'TrueTTS',
  fullPath: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS',
  isRoot: false,
});

// Test 8: Paths within a sub-directory of a project (should still find project root)
console.log('\nTest 8: Deep paths within TrueTTS');
const deepResult = inferProjectFromPaths([
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/voice.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/tts_engine.py',
  '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/audio.py',
]);
assert('Deep paths still infer TrueTTS', deepResult, {
  name: 'TrueTTS',
  fullPath: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS',
  isRoot: false,
});

// Test 9: Relative paths mixed with absolute (relative should be ignored)
console.log('\nTest 9: Relative paths are filtered out');
const relativeResult = inferProjectFromPaths([
  'relative/path/to/file.ts',
  './another/relative.ts',
  '/Users/ethangabis/Desktop/Projects/claude-memory/processor/session-tailer.ts',
]);
// Only 1 absolute path after filtering → < 2, returns null
assertNull('Relative paths ignored, not enough absolute', relativeResult);

// Test 10: Simulate the exact per-chunk flow from session-tailer:
// projectIsRoot=true and filePathsSinceLastExtraction has TrueTTS paths
console.log('\nTest 10: Simulated per-chunk flow (projectIsRoot=true scenario)');
{
  const projectIsRoot = true;
  const projectName = 'Projects'; // session cwd is /Desktop/Projects
  const filePathsSinceLastExtraction = new Set([
    '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
    '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/routers/tts.py',
    '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/services/voice.py',
  ]);

  // Replicate the exact logic from session-tailer.ts lines 466-481
  let chunkProjectName = projectName;
  let chunkProjectPath: string | null = '/Users/ethangabis/Desktop/Projects';
  let chunkIsRoot = projectIsRoot;

  if (projectIsRoot && filePathsSinceLastExtraction.size >= 2) {
    const inferred = inferProjectFromPaths([...filePathsSinceLastExtraction]);
    if (inferred && inferred.name && inferred.fullPath && !inferred.isRoot) {
      chunkProjectName = inferred.name;
      chunkProjectPath = inferred.fullPath;
      chunkIsRoot = false;
    }
  }

  const chunkOk =
    chunkProjectName === 'TrueTTS' &&
    chunkProjectPath === '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS' &&
    chunkIsRoot === false;

  if (chunkOk) {
    console.log('  PASS  Per-chunk flow correctly overrides root project with TrueTTS');
    passed++;
  } else {
    console.log('  FAIL  Per-chunk flow did not override correctly');
    console.log(`    chunkProjectName: ${chunkProjectName} (expected TrueTTS)`);
    console.log(`    chunkProjectPath: ${chunkProjectPath}`);
    console.log(`    chunkIsRoot: ${chunkIsRoot} (expected false)`);
    failed++;
  }
}

// Test 11: Per-chunk flow with claude-memory paths
console.log('\nTest 11: Simulated per-chunk flow with claude-memory paths');
{
  const projectIsRoot = true;
  const projectName = 'Projects';
  const filePathsSinceLastExtraction = new Set([
    '/Users/ethangabis/Desktop/Projects/claude-memory/processor/session-tailer.ts',
    '/Users/ethangabis/Desktop/Projects/claude-memory/mcp/server.ts',
    '/Users/ethangabis/Desktop/Projects/claude-memory/shared/project-inferrer.ts',
  ]);

  let chunkProjectName = projectName;
  let chunkProjectPath: string | null = '/Users/ethangabis/Desktop/Projects';
  let chunkIsRoot = projectIsRoot;

  if (projectIsRoot && filePathsSinceLastExtraction.size >= 2) {
    const inferred = inferProjectFromPaths([...filePathsSinceLastExtraction]);
    if (inferred && inferred.name && inferred.fullPath && !inferred.isRoot) {
      chunkProjectName = inferred.name;
      chunkProjectPath = inferred.fullPath;
      chunkIsRoot = false;
    }
  }

  const chunkOk =
    chunkProjectName === 'claude-memory' &&
    chunkProjectPath === '/Users/ethangabis/Desktop/Projects/claude-memory' &&
    chunkIsRoot === false;

  if (chunkOk) {
    console.log('  PASS  Per-chunk flow correctly overrides root project with claude-memory');
    passed++;
  } else {
    console.log('  FAIL  Per-chunk flow did not override correctly');
    console.log(`    chunkProjectName: ${chunkProjectName} (expected claude-memory)`);
    console.log(`    chunkProjectPath: ${chunkProjectPath}`);
    console.log(`    chunkIsRoot: ${chunkIsRoot} (expected false)`);
    failed++;
  }
}

// Test 12: Per-chunk flow does NOT override when projectIsRoot=false
console.log('\nTest 12: Per-chunk flow skips when projectIsRoot=false');
{
  const projectIsRoot = false;
  const projectName = 'claude-memory';
  const filePathsSinceLastExtraction = new Set([
    '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/main.py',
    '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/app/routers/tts.py',
  ]);

  let chunkProjectName = projectName;
  let chunkProjectPath: string | null = '/Users/ethangabis/Desktop/Projects/claude-memory';
  let chunkIsRoot = projectIsRoot;

  if (projectIsRoot && filePathsSinceLastExtraction.size >= 2) {
    const inferred = inferProjectFromPaths([...filePathsSinceLastExtraction]);
    if (inferred && inferred.name && inferred.fullPath && !inferred.isRoot) {
      chunkProjectName = inferred.name;
      chunkProjectPath = inferred.fullPath;
      chunkIsRoot = false;
    }
  }

  // Should remain unchanged since projectIsRoot=false
  const chunkOk =
    chunkProjectName === 'claude-memory' &&
    chunkProjectPath === '/Users/ethangabis/Desktop/Projects/claude-memory' &&
    chunkIsRoot === false;

  if (chunkOk) {
    console.log('  PASS  Per-chunk flow correctly skips override when not root');
    passed++;
  } else {
    console.log('  FAIL  Per-chunk flow incorrectly modified project');
    console.log(`    chunkProjectName: ${chunkProjectName} (expected claude-memory)`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
