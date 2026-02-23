/**
 * Shared data layer for the Engram Dashboard and inspect CLI.
 *
 * All reads are error-tolerant — functions return safe defaults on failure,
 * never throw. SQLite opened read-only with WAL-compatible busy_timeout.
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  DashboardData,
  DaemonInfo,
  EpisodeStats,
  SessionInfo,
  RecentExtraction,
  ProjectCount,
  ImportanceCount,
} from '../dashboard/types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_DIR = path.join(os.homedir(), '.claude-memory');
const DB_PATH = path.join(MEMORY_DIR, 'memory.db');
const PID_PATH = path.join(MEMORY_DIR, 'engram.pid');
const STATE_PATH = path.join(MEMORY_DIR, 'engram-state.json');
const RECOLLECTIONS_DIR = path.join(MEMORY_DIR, 'recollections');
const STDERR_LOG = path.join(MEMORY_DIR, 'engram.stderr.log');

const RSS_LIMIT_MB = 400; // daemon default

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

let cachedRssMB: number | null = null;
let rssCachedAt = 0;
const RSS_CACHE_TTL = 10_000; // 10 seconds

let cachedRecollectionCount = 0;
let recollectionCachedAt = 0;
const RECOLLECTION_CACHE_TTL = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Singleton DB handle
// ---------------------------------------------------------------------------

let db: Database | null = null;

function getDb(): Database | null {
  if (db) return db;
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    db = new Database(DB_PATH, { readonly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch {
    return null;
  }
}

/** Close the singleton DB handle. Call on graceful shutdown. */
export function closeDashboardDb(): void {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Daemon health helpers
// ---------------------------------------------------------------------------

function readPidFile(): { pid: number | null; createdAt: number | null } {
  try {
    const lines = fs.readFileSync(PID_PATH, 'utf-8').trim().split('\n');
    const pid = parseInt(lines[0], 10);
    const createdAt = lines[1] ? parseInt(lines[1], 10) : null;
    if (isNaN(pid)) return { pid: null, createdAt: null };
    return { pid, createdAt: createdAt && !isNaN(createdAt) ? createdAt : null };
  } catch {
    return { pid: null, createdAt: null };
  }
}

function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchRssMB(pid: number, forceRefresh: boolean): Promise<number | null> {
  const now = Date.now();
  if (!forceRefresh && cachedRssMB !== null && now - rssCachedAt < RSS_CACHE_TTL) {
    return cachedRssMB;
  }
  try {
    const proc = Bun.spawn(['ps', '-o', 'rss=', '-p', String(pid)]);
    const text = await new Response(proc.stdout).text();
    const rssKB = parseInt(text.trim(), 10);
    if (isNaN(rssKB)) return cachedRssMB;
    cachedRssMB = Math.round(rssKB / 1024);
    rssCachedAt = now;
    return cachedRssMB;
  } catch {
    return cachedRssMB;
  }
}

// ---------------------------------------------------------------------------
// Log scanning (last 50KB)
// ---------------------------------------------------------------------------

function scanLog(): { embedFailures: number; api429Errors: number; tailLines: string[] } {
  const defaults = { embedFailures: 0, api429Errors: 0, tailLines: [] as string[] };
  try {
    const stat = fs.statSync(STDERR_LOG);
    const readSize = Math.min(stat.size, 50 * 1024);
    const fd = fs.openSync(STDERR_LOG, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n');

    let embedFailures = 0;
    let api429Errors = 0;
    for (const line of lines) {
      if (line.includes('Failed to embed')) embedFailures++;
      if (/\b429\b/.test(line)) api429Errors++;
    }

    // Last 20 non-empty lines for the tail
    const tailLines = lines.filter(l => l.length > 0).slice(-20);

    return { embedFailures, api429Errors, tailLines };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Recollection count (cached)
// ---------------------------------------------------------------------------

function getRecollectionCount(): number {
  const now = Date.now();
  if (now - recollectionCachedAt < RECOLLECTION_CACHE_TTL) {
    return cachedRecollectionCount;
  }
  try {
    const entries = fs.readdirSync(RECOLLECTIONS_DIR);
    cachedRecollectionCount = entries.filter(e => e.endsWith('.json')).length;
    recollectionCachedAt = now;
    return cachedRecollectionCount;
  } catch {
    return cachedRecollectionCount;
  }
}

// ---------------------------------------------------------------------------
// Session states from engram-state.json
// ---------------------------------------------------------------------------

function getSessionStates(): SessionInfo[] {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const state = JSON.parse(raw) as { sessions?: Record<string, any> };
    if (!state.sessions) return [];

    return Object.entries(state.sessions).map(([sessionId, s]) => ({
      sessionId,
      byteOffset: typeof s.byteOffset === 'number' ? s.byteOffset : 0,
      messagesSinceExtraction: typeof s.messagesSinceExtraction === 'number' ? s.messagesSinceExtraction : 0,
      lastExtractedAt: typeof s.lastExtractedAt === 'number' ? s.lastExtractedAt : 0,
      hasRecollection: fs.existsSync(path.join(RECOLLECTIONS_DIR, `${sessionId}.json`)),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

function getSchemaVersion(database: Database): number {
  try {
    const row = database.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function getTotalEpisodes(database: Database): number {
  try {
    const row = database.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getByProject(database: Database): ProjectCount[] {
  try {
    const rows = database.prepare(`
      SELECT COALESCE(project, '(global)') as name, COUNT(*) as count
      FROM episodes
      GROUP BY project
      ORDER BY count DESC
    `).all() as ProjectCount[];
    return rows;
  } catch {
    return [];
  }
}

function getByImportance(database: Database): ImportanceCount[] {
  try {
    const rows = database.prepare(`
      SELECT importance, COUNT(*) as count
      FROM episodes
      GROUP BY importance
      ORDER BY count DESC
    `).all() as ImportanceCount[];
    return rows;
  } catch {
    return [];
  }
}

function getChunkCount(database: Database): number {
  try {
    const row = database.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getCacheCount(database: Database): number {
  try {
    const row = database.prepare('SELECT COUNT(*) as cnt FROM embedding_cache').get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function getRecentExtractions(database: Database, limit = 10): RecentExtraction[] {
  try {
    const rows = database.prepare(`
      SELECT id, summary, importance, created_at, project
      FROM episodes
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as { id: string; summary: string; importance: string; created_at: number; project: string | null }[];
    return rows.map(r => ({
      id: r.id,
      summary: r.summary,
      importance: r.importance,
      createdAt: r.created_at,
      project: r.project,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fetchDashboardData(
  options?: { refreshRss?: boolean },
): Promise<DashboardData> {
  // -- Daemon --
  const { pid, createdAt } = readPidFile();
  const running = pid !== null && isDaemonAlive(pid);
  const uptimeMs = running && createdAt ? Date.now() - createdAt : null;
  const rssMB = running && pid !== null
    ? await fetchRssMB(pid, options?.refreshRss ?? false)
    : null;

  const logData = scanLog();
  const sessions = getSessionStates();

  const daemon: DaemonInfo = {
    running,
    pid,
    uptimeMs,
    rssMB,
    rssLimitMB: RSS_LIMIT_MB,
    embedFailures: logData.embedFailures,
    api429Errors: logData.api429Errors,
    sessionCount: sessions.length,
    recollectionCount: getRecollectionCount(),
  };

  // -- Episodes --
  const database = getDb();
  const episodes: EpisodeStats = database
    ? {
        total: getTotalEpisodes(database),
        schemaVersion: getSchemaVersion(database),
        byProject: getByProject(database),
        byImportance: getByImportance(database),
        chunkCount: getChunkCount(database),
        cacheCount: getCacheCount(database),
      }
    : {
        total: 0,
        schemaVersion: 0,
        byProject: [],
        byImportance: [],
        chunkCount: 0,
        cacheCount: 0,
      };

  // -- Recent extractions --
  const recentExtractions = database ? getRecentExtractions(database) : [];

  return {
    daemon,
    episodes,
    sessions,
    recentExtractions,
    logTail: logData.tailLines,
  };
}
