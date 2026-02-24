#!/usr/bin/env bun
/**
 * Repair script: Fix mis-tagged episode project assignments.
 *
 * Problem: runStartupMigration assigns all episodes in a session to a single
 * majority-voted project. Sessions from /Desktop/Projects contain episodes
 * about multiple sub-projects, causing ~103 episodes (~9.1%) to be mis-tagged.
 *
 * Three categories of mis-tags:
 *   A) Global episodes whose summaries clearly reference a specific project
 *   B) Episodes tagged as one project but whose content is about another
 *      (e.g., engram/memory-system episodes tagged as TrueTTS because
 *       the session CWD was TrueTTS)
 *   C) claude-memory episodes that are actually about TTS dashboard
 *
 * Usage:
 *   bun scripts/repair-episode-tags.ts           # dry-run (print report)
 *   bun scripts/repair-episode-tags.ts --apply   # backup DB and apply fixes
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DB_PATH = path.join(os.homedir(), '.claude-memory', 'memory.db');
const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// Known projects and their canonical DB values
// ---------------------------------------------------------------------------

interface ProjectMapping {
  project: string;
  project_path: string;
  scope: 'project';
}

const PROJECTS: Record<string, ProjectMapping> = {
  'claude-memory': {
    project: 'claude-memory',
    project_path: '/Users/ethangabis/Desktop/Projects/claude-memory',
    scope: 'project',
  },
  TrueTTS: {
    project: 'TrueTTS',
    project_path: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS',
    scope: 'project',
  },
  MM: {
    project: 'MM',
    project_path: '/Users/ethangabis/Desktop/Projects/MM',
    scope: 'project',
  },
  'frontend-new': {
    project: 'frontend-new',
    project_path: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS/frontend-new',
    scope: 'project',
  },
};

// ---------------------------------------------------------------------------
// Content-based classification rules
// ---------------------------------------------------------------------------

interface ClassificationRule {
  /** Target project to assign */
  target: string;
  /** Patterns that strongly indicate this project (case-insensitive) */
  strongPatterns: RegExp[];
  /** Patterns that weakly indicate (need multiple matches) */
  weakPatterns: RegExp[];
  /** Anti-patterns: if these match, do NOT reclassify to this project */
  antiPatterns: RegExp[];
}

const RULES: ClassificationRule[] = [
  {
    target: 'claude-memory',
    strongPatterns: [
      /\bengram\b/i,
      /\bengram v2\b/i,
      /\bmemory\.db\b/i,
      /\bepisodes?\s+table\b/i,
      /\bepisode\s+upsert\b/i,
      /\bconsolidation\s+(pipeline|system|process)\b/i,
      /\brecollect(ion)?\s+(pipeline|endpoint)\b/i,
      /\bmemory_save\b/i,
      /\bmemory_search\b/i,
      /\bmemory_recall\b/i,
      /\bembedding\s+(backfill|provider|model)\b/i,
      /\bgguf\b/i,
      /\bengram-data\.ts\b/i,
      /\bSessionTailer\b/i,
      /\bproject-resolver\b/i,
      /\bproject-inferrer\b/i,
      /\bdaemon\s+health\b/i,
      /\bmemory\s+daemon\b/i,
      /\bclaud[e-]+mem(ory)?\b/i,
      /\bengram\s+background\b/i,
      /\bbelief\s+(system|network|layer)\b/i,
    ],
    weakPatterns: [
      /\bmemory system\b/i,
      /\bepisodes?\b(?!.*tv|.*show|.*series)/i,
      /\bretrieval\b/i,
      /\bembedding/i,
      /\bsqlite\b/i,
      /\bdashboard\b/i,
      /\bcuration\b/i,
      /\bMMR\b/,
      /\bre-?rank/i,
    ],
    antiPatterns: [
      // These indicate TrueTTS context, not memory system development
      /\bvoice\b/i,
      /\bspeech\s+(synth|to|recogn)/i,
      /\baudio\b/i,
      /\baws\s+(app\s+runner|amplify|ec2|gpu)\b/i,
      /\bTTS\s+API\b/i,
      /\bTTS\s+server\b/i,
    ],
  },
  {
    target: 'TrueTTS',
    strongPatterns: [
      /\bTrueTTS\b/,
      /\bTTS[\s-]+(API|server|backend|frontend|deploy|infra|launch)\b/i,
      /\bvoice\s+(cloning|synth|model|sample)/i,
      /\bspeech\s+synth/i,
      /\btext[\s-]+to[\s-]+speech\b/i,
      /\baws\s+(app\s+runner|amplify|ec2|gpu)\b/i,
      /\bmic[\s-]+launch/i,
      /\btts[\s-]+aws\b/i,
      /\bTTS\s+dashboard\b/i,
      /\bTrueTTS\s+(codebase|infrastructure|deployment|project)\b/i,
    ],
    weakPatterns: [
      /\bTTS\b/,
      /\bvoice\b/i,
      /\baudio\b/i,
      /\bspeech\b/i,
      /\bfrontend[\s-]+new\b/i,
    ],
    antiPatterns: [],
  },
  {
    target: 'MM',
    strongPatterns: [
      /\bproject\s+'?MM'?\b/,
      /\bMM\s+(project|system|architecture|schema|database|agents?)\b/i,
      /\bMM's\b/,
      /\bstartup[\s-]+sim(ulation)?\b/i,
      /\bmulti[\s-]+agent\s+(?:startup|team)\b/i,
      /\bswarm\s+mode\b/i,
      /\bpersistent\s+subagent/i,
    ],
    weakPatterns: [
      /\bMM\b/,
      /\bagent\s+team/i,
      /\bmulti[\s-]+agent/i,
    ],
    antiPatterns: [],
  },
];

// ---------------------------------------------------------------------------
// Parent-child project relationships (child → parent)
// Episodes in a child project should NOT be reclassified to parent just
// because they mention the parent project name.
// ---------------------------------------------------------------------------

const CHILD_TO_PARENT: Record<string, string> = {
  'frontend-new': 'TrueTTS',
  'mic-launch-video': 'TrueTTS',
  'frontend': 'MM',
  'backend': 'MM',
  'TrueTTS': 'TTS',
};

function isChildOfTarget(currentProject: string | null, targetProject: string): boolean {
  if (!currentProject) return false;
  return CHILD_TO_PARENT[currentProject] === targetProject;
}

// ---------------------------------------------------------------------------
// Classification engine
// ---------------------------------------------------------------------------

interface ReclassifyResult {
  episodeId: string;
  oldProject: string | null;
  oldProjectPath: string | null;
  oldScope: string;
  newProject: string;
  newProjectPath: string;
  newScope: string;
  reason: string;
  summary: string;
}

function classifyEpisode(
  summary: string,
  currentProject: string | null,
  currentScope: string,
): { target: string; reason: string } | null {
  for (const rule of RULES) {
    // Skip if episode is already correctly tagged
    if (currentProject === rule.target) continue;

    // Skip if current project is a child of the target project.
    // E.g., don't reclassify frontend-new episodes to TrueTTS just because
    // they mention "TrueTTS" -- that's just contextual reference to the parent.
    if (isChildOfTarget(currentProject, rule.target)) continue;

    // Check anti-patterns first
    const hasAntiPattern = rule.antiPatterns.some(p => p.test(summary));

    // Check strong patterns
    const strongMatches = rule.strongPatterns.filter(p => p.test(summary));
    if (strongMatches.length > 0 && !hasAntiPattern) {
      return {
        target: rule.target,
        reason: `Strong match: ${strongMatches[0].source}`,
      };
    }

    // Check weak patterns (need 2+ matches AND no anti-patterns)
    const weakMatches = rule.weakPatterns.filter(p => p.test(summary));
    if (weakMatches.length >= 2 && !hasAntiPattern) {
      return {
        target: rule.target,
        reason: `Weak matches (${weakMatches.length}): ${weakMatches.map(m => m.source).join(', ')}`,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Special case: TrueTTS episodes about engram that need careful handling
// ---------------------------------------------------------------------------

/**
 * Some episodes tagged TrueTTS are about configuring the memory system FOR TrueTTS
 * (e.g., "Updated CLAUDE.md with memory system override instructions").
 * These should STAY as TrueTTS. We only reclassify episodes that are clearly
 * about DEVELOPING the memory system itself.
 */
function isEngramDevelopment(summary: string): boolean {
  const devIndicators = [
    /\bengram v2\b/i,
    /\bengram-data\.ts\b/i,
    /\bdaemon\s+(health|status|panel|process)\b/i,
    /\bTUI\s+dashboard\b/i,
    /\blive\s+TUI\b/i,
    /\bdata\s+layer\b.*\bengram\b/i,
    /\bengram\s+recollection\b/i,
    /\bepisode\s+upsert\b/i,
    /\bembedding\s+backfill\b/i,
    /\bmemory\.db\b/i,
    /\bengram\.db\b/i,
    /\bcodebase\s+map\s+of\s+the\s+engram\b/i,
    /\bEngram\s+(system|background|fixes)\b/i,
    /\bdashboard\s+(data\s+sources|configurations?|feature|monitor)/i,
    /\bshared\s+data\s+layer\b/i,
    /\bscripts\/lib\b/i,
    /\binspect\s+and\s+dashboard\b/i,
    /\bNULL\s+embedding\b/i,
    /\bauto[\s-]+curation\b/i,
    /\bper[\s-]+candidate\s+try\b/i,
    /\bopenclaw.*(memory|feature)/i,
    /\bMMR\s+re[\s-]+rank/i,
  ];
  return devIndicators.some(p => p.test(summary));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('=== Episode Tag Repair Script ===');
console.log(`Mode: ${APPLY ? 'APPLY (will modify DB)' : 'DRY RUN (read-only)'}`);
console.log(`Database: ${DB_PATH}\n`);

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });
db.exec('PRAGMA busy_timeout = 5000');

// Load all episodes
const episodes = db.prepare(`
  SELECT id, session_id, project, project_path, scope, summary
  FROM episodes
`).all() as {
  id: string;
  session_id: string;
  project: string | null;
  project_path: string | null;
  scope: string;
  summary: string;
}[];

console.log(`Total episodes: ${episodes.length}\n`);

const changes: ReclassifyResult[] = [];

for (const ep of episodes) {
  // Phase 1: Content-based classification using rules
  const result = classifyEpisode(ep.summary, ep.project, ep.scope);

  if (result) {
    const mapping = PROJECTS[result.target];
    if (!mapping) continue;

    // Special guard: for TrueTTS->claude-memory reclassification,
    // only reclassify if it's clearly about engram development
    if (ep.project === 'TrueTTS' && result.target === 'claude-memory') {
      if (!isEngramDevelopment(ep.summary)) continue;
    }

    changes.push({
      episodeId: ep.id,
      oldProject: ep.project,
      oldProjectPath: ep.project_path,
      oldScope: ep.scope,
      newProject: mapping.project,
      newProjectPath: mapping.project_path,
      newScope: mapping.scope,
      reason: result.reason,
      summary: ep.summary.length > 120 ? ep.summary.slice(0, 117) + '...' : ep.summary,
    });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('=== Dry-Run Report ===\n');

// Group by old -> new project transition
const transitions = new Map<string, ReclassifyResult[]>();
for (const c of changes) {
  const key = `${c.oldScope}:${c.oldProject ?? '(none)'} → ${c.newScope}:${c.newProject}`;
  if (!transitions.has(key)) transitions.set(key, []);
  transitions.get(key)!.push(c);
}

for (const [transition, items] of [...transitions.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n--- ${transition} (${items.length} episodes) ---`);
  for (const item of items.slice(0, 10)) {
    console.log(`  ${item.episodeId}: ${item.summary}`);
    console.log(`    Reason: ${item.reason}`);
  }
  if (items.length > 10) {
    console.log(`  ... and ${items.length - 10} more`);
  }
}

console.log(`\n=== Summary ===`);
console.log(`Total episodes scanned: ${episodes.length}`);
console.log(`Episodes to reclassify: ${changes.length}`);
for (const [transition, items] of [...transitions.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${transition}: ${items.length}`);
}

// ---------------------------------------------------------------------------
// Apply changes
// ---------------------------------------------------------------------------

if (APPLY && changes.length > 0) {
  // Backup the database
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.bak-${timestamp}`;
  console.log(`\nBacking up database to: ${backupPath}`);
  fs.copyFileSync(DB_PATH, backupPath);
  // Also copy WAL and SHM if they exist
  for (const ext of ['-wal', '-shm']) {
    const src = DB_PATH + ext;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, backupPath + ext);
    }
  }
  console.log('Backup complete.');

  const updateStmt = db.prepare(`
    UPDATE episodes
    SET project = ?, project_path = ?, scope = ?
    WHERE id = ?
  `);

  db.exec('BEGIN TRANSACTION');
  let applied = 0;
  for (const c of changes) {
    updateStmt.run(c.newProject, c.newProjectPath, c.newScope, c.episodeId);
    applied++;
  }
  db.exec('COMMIT');

  console.log(`\nApplied ${applied} changes successfully.`);
} else if (APPLY && changes.length === 0) {
  console.log('\nNo changes to apply.');
} else {
  console.log(`\nTo apply these changes, run: bun scripts/repair-episode-tags.ts --apply`);
}

db.close();
