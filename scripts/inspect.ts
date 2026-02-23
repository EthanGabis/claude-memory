#!/usr/bin/env bun
/**
 * Engram Inspection CLI — view daemon health, episodes, sessions, extractions.
 * Usage: bun scripts/inspect.ts [--json]
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MEMORY_DIR = path.join(os.homedir(), '.claude-memory');
const DB_PATH = path.join(MEMORY_DIR, 'memory.db');
const PID_PATH = path.join(MEMORY_DIR, 'engram.pid');
const STATE_PATH = path.join(MEMORY_DIR, 'engram-state.json');
const RECOLLECTIONS_DIR = path.join(MEMORY_DIR, 'recollections');

const jsonMode = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Daemon health
// ---------------------------------------------------------------------------

interface DaemonHealth {
  running: boolean;
  pid: number | null;
  uptime: string | null;
}

function getDaemonHealth(): DaemonHealth {
  try {
    const pidStr = fs.readFileSync(PID_PATH, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return { running: false, pid: null, uptime: null };

    try {
      process.kill(pid, 0);
    } catch {
      return { running: false, pid, uptime: null };
    }

    const stat = fs.statSync(PID_PATH);
    const uptimeMs = Date.now() - stat.mtimeMs;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);

    return { running: true, pid, uptime: `${hours}h ${mins}m` };
  } catch {
    return { running: false, pid: null, uptime: null };
  }
}

// ---------------------------------------------------------------------------
// Episode counts
// ---------------------------------------------------------------------------

interface EpisodeCount {
  project: string | null;
  scope: string;
  importance: string;
  count: number;
}

function getEpisodeCounts(db: Database): EpisodeCount[] {
  return db.prepare(`
    SELECT project, scope, importance, COUNT(*) as count
    FROM episodes
    GROUP BY project, scope, importance
    ORDER BY count DESC
  `).all() as EpisodeCount[];
}

function getTotalEpisodes(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number };
  return row.cnt;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionInfo {
  sessionId: string;
  byteOffset: number;
  messagesSinceExtraction: number;
  lastExtractedAt: number;
  hasRecollectionFile: boolean;
}

function getSessionStates(): SessionInfo[] {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const state = JSON.parse(raw) as { sessions?: Record<string, any> };
    if (!state.sessions) return [];

    return Object.entries(state.sessions).map(([sessionId, s]) => ({
      sessionId: sessionId.slice(0, 8) + '...',
      byteOffset: s.byteOffset ?? 0,
      messagesSinceExtraction: s.messagesSinceExtraction ?? 0,
      lastExtractedAt: s.lastExtractedAt ?? 0,
      hasRecollectionFile: fs.existsSync(path.join(RECOLLECTIONS_DIR, `${sessionId}.json`)),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Recent extractions
// ---------------------------------------------------------------------------

interface RecentEpisode {
  id: string;
  summary: string;
  importance: string;
  created_at: number;
  project: string | null;
}

function getRecentExtractions(db: Database, limit = 10): RecentEpisode[] {
  return db.prepare(`
    SELECT id, summary, importance, created_at, project
    FROM episodes
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as RecentEpisode[];
}

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

function getSchemaVersion(db: Database): number {
  try {
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Database not found at', DB_PATH);
    console.error('Has the Engram processor or MCP server been started at least once?');
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');

  const health = getDaemonHealth();
  const schemaVersion = getSchemaVersion(db);
  const totalEpisodes = getTotalEpisodes(db);
  const counts = getEpisodeCounts(db);
  const sessions = getSessionStates();
  const recentExtractions = getRecentExtractions(db);

  if (jsonMode) {
    console.log(JSON.stringify({
      daemon: health,
      schemaVersion,
      episodes: { total: totalEpisodes, breakdown: counts },
      sessions,
      recentExtractions,
    }, null, 2));
    db.close();
    return;
  }

  // Pretty-print
  console.log('=== Engram Daemon ===');
  if (health.running) {
    console.log(`  Status:  RUNNING (PID ${health.pid})`);
    console.log(`  Uptime:  ${health.uptime}`);
  } else {
    console.log(`  Status:  NOT RUNNING${health.pid ? ` (stale PID: ${health.pid})` : ''}`);
  }
  console.log(`  Schema:  v${schemaVersion}`);

  console.log(`\n=== Episodes (${totalEpisodes} total) ===`);
  if (counts.length === 0) {
    console.log('  (none)');
  } else {
    for (const c of counts) {
      const proj = c.project ? c.project.slice(0, 25) : '(global)';
      console.log(`  ${proj.padEnd(27)} ${c.scope.padEnd(8)} ${c.importance.padEnd(7)} ${c.count}`);
    }
  }

  console.log(`\n=== Active Sessions (${sessions.length}) ===`);
  if (sessions.length === 0) {
    console.log('  (none)');
  } else {
    for (const s of sessions) {
      const ago = Date.now() - s.lastExtractedAt;
      const agoMin = Math.floor(ago / 60_000);
      const recoll = s.hasRecollectionFile ? 'yes' : 'no';
      console.log(`  ${s.sessionId} | offset=${s.byteOffset} | pending=${s.messagesSinceExtraction} | extracted ${agoMin}m ago | recollection=${recoll}`);
    }
  }

  console.log(`\n=== Recent Extractions ===`);
  if (recentExtractions.length === 0) {
    console.log('  (none)');
  } else {
    for (const e of recentExtractions) {
      const date = new Date(e.created_at).toLocaleString();
      const imp = e.importance === 'high' ? ' [HIGH]' : '';
      const proj = e.project ? ` (${e.project.slice(0, 15)})` : '';
      console.log(`  ${date}${imp}${proj} ${e.summary.slice(0, 70)}`);
    }
  }

  db.close();
}

main();
