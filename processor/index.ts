import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { LocalGGUFProvider } from '../mcp/providers.js';
import { StateStore } from './state.js';
import { SessionTailer } from './session-tailer.js';
import { runConsolidation } from './consolidator.js';
import { SOCKET_PATH } from '../shared/uds.js';
import { writeRecollections } from './recollection-writer.js';
import { resolveProjectFromJsonlPath } from '../shared/project-resolver.js';
import { upsertProject, generateProjectDescription } from '../shared/project-describer.js';
import { extractFilePathsFromJsonl, extractFilePathsFromSession } from '../shared/file-path-extractor.js';
import { inferProjectFromPaths, PROJECT_MARKERS } from '../shared/project-inferrer.js';
import { detectParentProject, detectParentsInMemory, invalidateFamilyCache } from '../shared/project-family.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PID_PATH = path.join(os.homedir(), '.claude-memory', 'engram.pid');
const MEMORY_WARN_MB = 300;
const MEMORY_RESTART_MB = 400;
const SESSION_SCAN_INTERVAL_MS = 60_000;
const COLD_CONSOLIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_FILE_AGE_DAYS = 3;
const STARTUP_MEMORY_CHECK_MS = 10_000; // check memory every 10s during startup burst
const STARTUP_BURST_DURATION_MS = 5 * 60 * 1000; // first 5 minutes

// ---------------------------------------------------------------------------
// PID file management (atomic: O_CREAT | O_EXCL)
// ---------------------------------------------------------------------------

let pidFd: number | null = null;

// W4: PID reuse protection — max age for a PID file to be considered valid
const PID_MAX_AGE_DAYS = 30;

function acquirePidFile(): boolean {
  fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      pidFd = fs.openSync(PID_PATH, 'wx');
      // W4: Write PID and creation timestamp for PID reuse detection
      fs.writeSync(pidFd, `${process.pid}\n${Date.now()}`);
      fs.fsyncSync(pidFd); // Ensure PID is visible to other processes immediately
      return true;
    } catch {
      // PID file exists — check if owner is alive
      try {
        const pidContent = fs.readFileSync(PID_PATH, 'utf-8').trim();
        const lines = pidContent.split('\n');
        const pid = parseInt(lines[0], 10);
        const createdAt = lines[1] ? parseInt(lines[1], 10) : 0;
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0);
            // W4: PID is alive, but check for PID reuse — if the file is very old,
            // the PID likely belongs to an unrelated process
            if (createdAt > 0 && Date.now() - createdAt > PID_MAX_AGE_DAYS * 86_400_000) {
              console.error(`[engram] PID ${pid} alive but PID file is ${Math.round((Date.now() - createdAt) / 86_400_000)}d old — likely PID reuse, reclaiming`);
              // Fall through to remove stale file
            } else {
              console.error(`[engram] Another instance is already running (PID ${pid}, age ${Math.round((Date.now() - (createdAt || Date.now())) / 1000)}s)`);
              return false; // Another instance is genuinely running
            }
          } catch (killErr: any) {
            // ESRCH = process doesn't exist → stale PID file
            // EPERM = process exists but we can't signal it → still alive, DON'T reclaim
            if (killErr?.code === 'EPERM') {
              console.error(`[engram] PID ${pid} exists but EPERM — cannot reclaim`);
              return false;
            }
            // PID is dead — stale file, fall through to remove
            console.error(`[engram] PID ${pid} is dead — removing stale PID file`);
          }
        }
      } catch {
        // Can't read PID file
      }
      // Remove stale PID file and retry
      try { fs.unlinkSync(PID_PATH); } catch {}
    }
  }

  return false; // Failed after max retries
}

function removePidFile(): void {
  if (pidFd !== null) {
    try { fs.closeSync(pidFd); } catch {}
    pidFd = null;
  }
  try { fs.unlinkSync(PID_PATH); } catch {}
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

function discoverSessions(): string[] {
  const sessions: string[] = [];
  const cutoff = Date.now() - MAX_FILE_AGE_DAYS * 86_400_000;

  try {
    // Scan ~/.claude/projects/*/*.jsonl
    const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectEntries) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(PROJECTS_DIR, projectDir.name);

      try {
        const files = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.name.endsWith('.jsonl')) continue;
          if (!file.isFile()) continue;

          const filePath = path.join(projectPath, file.name);

          // Exclude subagents
          if (filePath.split(path.sep).includes('subagents')) continue; // N2: path-separator aware

          // Filter by modification time
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs >= cutoff) {
              sessions.push(filePath);
            }
          } catch {
            // stat failed — skip
          }
        }
      } catch {
        // Can't read project directory — skip
      }
    }
  } catch {
    console.error('[engram] Could not read projects directory');
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Memory monitoring
// ---------------------------------------------------------------------------

function checkMemoryUsage(): void {
  const usage = process.memoryUsage();
  const rssMB = usage.rss / (1024 * 1024);

  if (rssMB >= MEMORY_RESTART_MB) {
    console.error(`[engram] Memory usage ${rssMB.toFixed(0)}MB exceeds ${MEMORY_RESTART_MB}MB — restarting`);
    shutdown('memory-limit');
  } else if (rssMB >= MEMORY_WARN_MB) {
    console.error(`[engram] Memory usage warning: ${rssMB.toFixed(0)}MB (limit: ${MEMORY_RESTART_MB}MB)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let db: Database;
let stateStore: StateStore;
const tailers = new Map<string, SessionTailer>();
let chokidarWatcher: any = null;
let shutdownInProgress = false;
let udsServer: ReturnType<typeof Bun.serve> | null = null;
const startTime = Date.now();
const RECOLLECTIONS_DIR = path.join(os.homedir(), '.claude-memory', 'recollections');

async function shutdown(reason: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  console.error(`[engram] Shutting down (${reason})...`);

  // Stop all tailers (await async stops with 10s timeout)
  await Promise.all(
    [...tailers.entries()].map(async ([id, tailer]) => {
      try {
        await Promise.race([
          Promise.resolve(tailer.stop()),
          new Promise(resolve => setTimeout(resolve, 10_000)),
        ]);
      } catch (err) {
        console.error(`[engram] Tailer stop failed for ${path.basename(id, '.jsonl').slice(0, 8)}: ${(err as Error).message}`);
      }
    })
  );
  tailers.clear();

  // Stop UDS server
  if (udsServer) {
    udsServer.stop();
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    udsServer = null;
  }

  // Stop chokidar watcher
  if (chokidarWatcher) {
    await chokidarWatcher.close();
    chokidarWatcher = null;
  }

  // Save state (safe to call even if not initialized — stop() checks dirty flag)
  if (stateStore) {
    stateStore.stop();
  }

  // Close DB (safe if not yet opened)
  if (db) {
    try {
      db.close();
    } catch {
      // Already closed
    }
  }

  // Remove PID file
  removePidFile();

  console.error('[engram] Shutdown complete');
  process.exit(reason === 'memory-limit' ? 1 : 0);
}

const HOT_SESSION_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function startTailer(jsonlPath: string): void {
  if (tailers.has(jsonlPath)) return;

  const sessionId = path.basename(jsonlPath, '.jsonl');

  // Skip cold sessions that are already fully caught up — saves memory by not
  // creating a tailer + watcher for sessions that won't receive new data
  try {
    const stat = fs.statSync(jsonlPath);
    const isCold = Date.now() - stat.mtimeMs > HOT_SESSION_THRESHOLD_MS;
    if (isCold) {
      const state = stateStore.getSession(sessionId);
      if (state.byteOffset >= stat.size) {
        // Already processed and no new data expected — skip
        return;
      }
    }
  } catch {
    // stat failed — try to start anyway
  }

  const llmApiKey = process.env.OPENAI_API_KEY ?? '';
  const projectInfo = resolveProjectFromJsonlPath(jsonlPath);

  // Auto-populate projects table
  if (projectInfo.name && projectInfo.fullPath && !projectInfo.isRoot) {
    try {
      const parentProject = detectParentProject(db, projectInfo.fullPath);
      upsertProject(db, projectInfo.name, projectInfo.fullPath, parentProject);
      invalidateFamilyCache();
    } catch (err) {
      console.error(`[engram] Project upsert failed for "${projectInfo.name}": ${(err as Error).message}`);
    }
  }

  const tailer = new SessionTailer(jsonlPath, stateStore, embedProvider, db, llmApiKey, projectInfo);
  tailers.set(jsonlPath, tailer);

  tailer.start().catch(err => {
    console.error(`[engram] Failed to start tailer for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    tailers.delete(jsonlPath);
  });
}

// Global embed provider — initialized in main()
let embedProvider: LocalGGUFProvider;

/**
 * Keyword rules for content-based project inference from episode summaries.
 * Each entry maps a project name to a list of case-insensitive keywords/phrases.
 * Checked against episode summary text to override session-level majority vote.
 */
const PROJECT_KEYWORD_RULES: { project: string; projectPath: string; keywords: RegExp }[] = [
  {
    project: 'TrueTTS',
    projectPath: '/Users/ethangabis/Desktop/Projects/TTS/TrueTTS',
    keywords: /\b(truetts|voice\s+clone|voice\s+generation|text[\s-]to[\s-]speech|tts\b(?!\s*project)|speech\s+synth|audio\s+generat|kokoro|piper|elevenlabs|playht)/i,
  },
  {
    project: 'claude-memory',
    projectPath: '/Users/ethangabis/Desktop/Projects/claude-memory',
    keywords: /\b(engram|memory\s+system|memory\s+daemon|episode[s]?\b(?!.*tv|.*show|.*series)|recollection|consolidat|belief[s]?\s+(system|store|updat)|mcp\s+server|mcp\s+tool|memory_save|memory_search|memory_recall|session[\s-]?tailer|embed\s+provider)/i,
  },
  {
    project: 'MM',
    projectPath: '/Users/ethangabis/Desktop/Projects/MM',
    keywords: /\b(matchmaker|MM\b(?!\s))/i,
  },
];

/**
 * Infer project for a single episode based on its summary text.
 * Returns the project name if a keyword rule matches, or null to use session default.
 */
function inferProjectFromSummary(summary: string): { project: string; projectPath: string } | null {
  for (const rule of PROJECT_KEYWORD_RULES) {
    if (rule.keywords.test(summary)) {
      return { project: rule.project, projectPath: rule.projectPath };
    }
  }
  return null;
}

/**
 * On startup, re-resolve all global episodes whose sessions might belong to a project.
 * Scans JSONL files for file paths and infers the real project.
 *
 * Per-episode refinement: after session-level inference determines a default project,
 * each episode's summary is checked against keyword rules. If a keyword match points
 * to a different project, that episode is tagged individually. This prevents sessions
 * from parent directories (e.g. /Desktop/Projects) from mis-tagging all episodes
 * with a single majority-vote project.
 *
 * Runs once per startup -- safe to repeat (idempotent).
 */
async function runStartupMigration(database: Database, openaiClient: any): Promise<void> {
  console.error('[engram] Running startup migration: re-resolving global episodes...');

  // Step 1: Get all session_ids that have global episodes
  const globalSessions = database.prepare(`
    SELECT DISTINCT session_id FROM episodes WHERE scope = 'global'
  `).all() as { session_id: string }[];

  if (globalSessions.length === 0) {
    console.error('[engram] No global episodes to re-resolve');
    return;
  }

  console.error(`[engram] Found ${globalSessions.length} sessions with global episodes`);

  // Step 2: Build session -> JSONL path mapping
  const sessionToJsonl = new Map<string, string>();
  try {
    const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projectDir of projectEntries) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(PROJECTS_DIR, projectDir.name);
      try {
        const files = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.name.endsWith('.jsonl') || !file.isFile()) continue;
          const sessionId = path.basename(file.name, '.jsonl');
          sessionToJsonl.set(sessionId, path.join(projectPath, file.name));
        }
      } catch {}
    }
  } catch {}

  // Step 3: For each global session, try file-path inference + per-episode refinement
  let rescoped = 0;
  let refined = 0;
  let projectsDiscovered = 0;

  // Bulk update: tag all global episodes in a session with the session-level project
  const updateSessionStmt = database.prepare(
    `UPDATE episodes SET scope = 'project', project = ?, project_path = ? WHERE session_id = ? AND scope = 'global'`
  );

  // Per-episode update: refine individual episodes whose summary matches a different project
  const updateEpisodeStmt = database.prepare(
    `UPDATE episodes SET project = ?, project_path = ? WHERE id = ?`
  );

  // Fetch global episodes for per-episode refinement
  const fetchEpisodesStmt = database.prepare(
    `SELECT id, summary, project FROM episodes WHERE session_id = ? AND scope = 'project'`
  );

  // Batch updates in groups of 20 sessions per transaction to avoid holding
  // the WAL lock for too long on large databases
  const BATCH_SIZE = 20;
  for (let i = 0; i < globalSessions.length; i += BATCH_SIZE) {
    const batch = globalSessions.slice(i, i + BATCH_SIZE);
    database.exec('BEGIN TRANSACTION');
    try {
      for (const { session_id } of batch) {
        const jsonlPath = sessionToJsonl.get(session_id);
        if (!jsonlPath) continue;

        try {
          const filePaths = extractFilePathsFromSession(jsonlPath, 10000);
          if (filePaths.length < 2) continue;

          const inferred = inferProjectFromPaths(filePaths, 0.4);
          if (!inferred || !inferred.name || inferred.isRoot) continue;

          // Phase 1: Bulk-tag all global episodes with the session-level project
          const result = updateSessionStmt.run(inferred.name, inferred.fullPath ?? null, session_id);
          const changes = (result as any).changes ?? 0;
          rescoped += changes;

          // Phase 2: Per-episode refinement using keyword heuristics on summary text
          // This corrects episodes that belong to a different project than the session majority
          if (changes > 0) {
            const episodes = fetchEpisodesStmt.all(session_id) as { id: string; summary: string; project: string }[];
            for (const ep of episodes) {
              const keywordMatch = inferProjectFromSummary(ep.summary);
              if (keywordMatch && keywordMatch.project !== ep.project) {
                updateEpisodeStmt.run(keywordMatch.project, keywordMatch.projectPath, ep.id);
                refined++;
              }
            }
          }

          // Upsert into projects table
          if (inferred.fullPath) {
            const parentProject = detectParentProject(database, inferred.fullPath);
            upsertProject(database, inferred.name, inferred.fullPath, parentProject);
            invalidateFamilyCache();
            projectsDiscovered++;

            // Generate description (fire-and-forget)
            if (openaiClient) {
              generateProjectDescription(inferred.fullPath, inferred.name, database, openaiClient)
                .catch(err => console.error(`[engram] Description gen failed for "${inferred.name}":`, err.message));
            }
          }
        } catch {}
      }

      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch {}
      console.error(`[engram] Startup migration batch failed (sessions ${i}-${i + batch.length}): ${(err as Error).message}`);
      // Continue with next batch instead of aborting entirely
    }
  }

  console.error(`[engram] Startup migration: ${rescoped} episodes re-scoped, ${refined} refined by keyword, ${projectsDiscovered} projects discovered`);
}

/**
 * Scan CLAUDE_MEMORY_PROJECT_ROOTS for subdirectories that look like projects.
 * Upsert them into the projects table.
 */
async function runProjectDiscovery(database: Database, openaiClient: any): Promise<void> {
  const roots = process.env.CLAUDE_MEMORY_PROJECT_ROOTS;
  if (!roots) return;

  let discovered = 0;
  for (const root of roots.split(':').map(r => r.trim()).filter(Boolean)) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // skip hidden dirs

        const dirPath = path.join(root, entry.name);

        // Check for project markers (imported from project-inferrer.ts)
        const isProject = PROJECT_MARKERS.some(m => {
          try { fs.statSync(path.join(dirPath, m)); return true; } catch { return false; }
        });

        if (isProject) {
          const parentProject = detectParentProject(database, dirPath);
          upsertProject(database, entry.name, dirPath, parentProject);
          invalidateFamilyCache();
          discovered++;

          // Generate description (fire-and-forget)
          if (openaiClient) {
            generateProjectDescription(dirPath, entry.name, database, openaiClient)
              .catch(err => console.error(`[engram] Description gen failed for "${entry.name}":`, err.message));
          }
        }
      }
    } catch {}
  }

  if (discovered > 0) {
    console.error(`[engram] Auto-discovered ${discovered} projects from filesystem`);
  }
}

/**
 * Backfill parent_project for all existing projects.
 * Runs once at startup after schema migration and project discovery.
 * Idempotent — only updates rows where parent_project changed.
 */
function runParentDetection(database: Database): void {
  const projects = database.prepare(
    `SELECT full_path, parent_project FROM projects`
  ).all() as { full_path: string; parent_project: string | null }[];

  const detected = detectParentsInMemory(projects);

  let updated = 0;
  const updateStmt = database.prepare(
    `UPDATE projects SET parent_project = ? WHERE full_path = ?`
  );

  for (const row of projects) {
    const newParent = detected.get(row.full_path) ?? null;
    if (newParent !== row.parent_project) {
      updateStmt.run(newParent, row.full_path);
      updated++;
    }
  }

  if (updated > 0) {
    invalidateFamilyCache();
    console.error(`[engram] Parent detection backfill: ${updated} projects updated`);
  }
}

async function main(): Promise<void> {
  console.error('[engram] Starting Engram Processor...');

  // 1. Register signal handlers FIRST (before PID file) so that if the
  //    process crashes during model load, the PID file still gets cleaned up.
  //    shutdown() is safe to call before DB/model are initialized.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 2. PID file check (atomic)
  if (!acquirePidFile()) {
    console.error('[engram] Another instance is already running — exiting');
    process.exit(0);
  }

  // 3. Load embedding model (same GGUF as MCP server)
  console.error('[engram] Loading embedding model...');
  embedProvider = new LocalGGUFProvider();
  // Warm up the model
  try {
    await embedProvider.embed(['warmup']);
    console.error('[engram] Embedding model ready');
  } catch (err) {
    console.error(`[engram] Embedding model failed to load: ${(err as Error).message}`);
    console.error('[engram] Continuing without embeddings — recollections will be limited');
  }

  console.error(`[engram] OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'set' : 'NOT SET'}`);

  // 4. Open SQLite DB (WAL mode, busy_timeout=5000 — set by initDb)
  db = initDb(DB_PATH);
  console.error('[engram] Database ready');

  // 4.5. Construct OpenAI client for project description generation
  const { default: OpenAI } = await import('openai');
  const openaiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  // 5. Load persistent state
  stateStore = new StateStore();
  stateStore.load();
  stateStore.startPeriodicSave();

  // 5.1. Startup migration: re-resolve global episodes using file-path inference
  await runStartupMigration(db, openaiClient);

  // 5.2. Auto-discover projects from filesystem
  await runProjectDiscovery(db, openaiClient);

  // 5.3. Backfill parent_project for all known projects
  runParentDetection(db);

  // 5.4. Purge stale .state and .state.lock files from recollections dir
  // These were used by the old PreToolUse dedup system and are no longer needed.
  try {
    fs.mkdirSync(RECOLLECTIONS_DIR, { recursive: true });
    const recollectionFiles = fs.readdirSync(RECOLLECTIONS_DIR);
    let purged = 0;
    for (const file of recollectionFiles) {
      if (file.endsWith('.state') || file.endsWith('.state.lock')) {
        try {
          fs.unlinkSync(path.join(RECOLLECTIONS_DIR, file));
          purged++;
        } catch {}
      }
    }
    if (purged > 0) {
      console.error(`[engram] Purged ${purged} stale .state/.state.lock files`);
    }
  } catch {}

  // 5.5. Start HTTP-over-UDS server for hook-to-daemon communication
  // Remove stale socket file if it exists
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });

  udsServer = Bun.serve({
    unix: SOCKET_PATH,
    async fetch(req) {
      const url = new URL(req.url);

      // POST /recollect — real-time recollection computation
      if (req.method === 'POST' && url.pathname === '/recollect') {
        try {
          const body = await req.json() as { prompt?: string; sessionId?: string };
          const { prompt, sessionId } = body;
          if (!prompt || !sessionId) {
            return Response.json({ error: 'Missing prompt or sessionId', bites: [] }, { status: 400 });
          }

          // Look up tailer by sessionId
          let tailerEntry: { tailer: SessionTailer; tailerPath: string } | null = null;
          for (const [tailerPath, tailer] of tailers) {
            if (path.basename(tailerPath, '.jsonl') === sessionId) {
              tailerEntry = { tailer, tailerPath };
              break;
            }
          }

          // Get previousEmbedding, projectName, and projectPath from the tailer, or use null for cold sessions
          const previousEmbedding = tailerEntry?.tailer.previousEmbedding ?? null;
          const projectName = tailerEntry?.tailer.projectName ?? null;
          const projectPath = tailerEntry?.tailer.projectPath ?? null;

          console.error(`[http] /recollect for session ${sessionId.slice(0, 8)} (tailer: ${tailerEntry ? 'found' : 'cold'})`);

          const result = await writeRecollections(
            sessionId,
            prompt,
            '', // no userMessageUuid from hook
            projectName,
            previousEmbedding,
            embedProvider,
            db,
            true, // force=true to bypass topic gate since this is a new prompt
            projectPath,
          );

          // Update tailer's previousEmbedding so topic gate works correctly
          if (tailerEntry) {
            tailerEntry.tailer.previousEmbedding = result.embedding;
          }

          // Read the recollection file that writeRecollections wrote
          const recollectionPath = path.join(RECOLLECTIONS_DIR, `${sessionId}.json`);
          try {
            const fileContent = fs.readFileSync(recollectionPath, 'utf-8');
            const recollection = JSON.parse(fileContent);
            return Response.json({ bites: recollection.bites ?? [], timestamp: recollection.timestamp ?? Date.now() });
          } catch {
            // File write may have been skipped (e.g. empty results)
            return Response.json({ bites: [], timestamp: Date.now() });
          }
        } catch (err: any) {
          console.error(`[http] /recollect error: ${err.message}`);
          return Response.json({ error: err.message, bites: [] }, { status: 500 });
        }
      }

      // POST /flush — force extraction for a session
      if (req.method === 'POST' && url.pathname === '/flush') {
        try {
          const body = await req.json() as { sessionId?: string };
          const { sessionId } = body;
          if (!sessionId) {
            return Response.json({ error: 'Missing sessionId' }, { status: 400 });
          }

          for (const [tailerPath, tailer] of tailers) {
            if (path.basename(tailerPath, '.jsonl') === sessionId) {
              console.error(`[http] Flush requested for session ${sessionId.slice(0, 8)}`);
              try {
                await tailer.flush();
              } catch (err: any) {
                console.error('[http] flush failed:', err.message);
              }
              break;
            }
          }
          return new Response('OK', { status: 200 });
        } catch (err: any) {
          console.error(`[http] /flush error: ${err.message}`);
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      // GET /health — daemon health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          status: 'ok',
          pid: process.pid,
          uptimeMs: Date.now() - startTime,
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  // Restrict socket permissions to owner only
  fs.chmodSync(SOCKET_PATH, 0o600);
  console.error(`[engram] HTTP-over-UDS server ready on ${SOCKET_PATH}`);

  // 6. Discover active sessions (sorted by recency — warm sessions first)
  const sessions = discoverSessions();
  console.error(`[engram] Discovered ${sessions.length} active sessions`);

  // Stagger tailer starts to avoid overwhelming embed model and API during startup burst
  const STARTUP_BATCH_SIZE = 3;
  const STARTUP_BATCH_DELAY_MS = 3000;

  // Sort by mtime descending — recently active sessions get processed first
  const sorted = sessions
    .map(p => {
      try { return { path: p, mtime: fs.statSync(p).mtimeMs }; }
      catch { return { path: p, mtime: 0 }; }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map(s => s.path);

  for (let i = 0; i < sorted.length; i += STARTUP_BATCH_SIZE) {
    const batch = sorted.slice(i, i + STARTUP_BATCH_SIZE);
    for (const jsonlPath of batch) {
      startTailer(jsonlPath);
    }
    if (i + STARTUP_BATCH_SIZE < sorted.length) {
      await new Promise(resolve => setTimeout(resolve, STARTUP_BATCH_DELAY_MS));
    }
  }
  console.error(`[engram] All ${sessions.length} tailers started (staggered)`);

  // 7. Watch for new JSONL files with chokidar
  try {
    const chokidar = await import('chokidar');
    chokidarWatcher = chokidar.watch(PROJECTS_DIR, {
      depth: 1, // only watch project-hash dirs, not deep subdirs
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500 },
    });

    chokidarWatcher.on('add', (filePath: string) => {
      if (!filePath.endsWith('.jsonl')) return;
      if (filePath.split(path.sep).includes('subagents')) return; // N2: path-separator aware
      console.error(`[engram] New session detected: ${path.basename(filePath, '.jsonl').slice(0, 8)}`);
      startTailer(filePath);
    });

    console.error('[engram] Watching for new sessions');
  } catch (err) {
    console.error(`[engram] Chokidar watch failed: ${(err as Error).message}`);
  }

  // 8. Periodic tasks
  // Session scan + tailer eviction every 60s
  // W1: Overlap guard — prevents long maintenance runs from racing on tailer stop/start
  let isScanning = false;
  setInterval(async () => {
    if (isScanning) return;
    isScanning = true;
    try {
    // Evict stale/missing tailers
    const toEvict: string[] = [];
    for (const [tailerPath, tailer] of tailers) {
      const shortId = path.basename(tailerPath, '.jsonl').slice(0, 8);
      let shouldEvict = false;
      try {
        const stat = fs.statSync(tailer.jsonlPath);
        if (Date.now() - stat.mtimeMs > MAX_FILE_AGE_DAYS * 86_400_000) {
          console.error(`[engram] Evicting stale tailer: ${shortId}`);
          shouldEvict = true;
        }
      } catch {
        console.error(`[engram] Evicting missing tailer: ${shortId}`);
        shouldEvict = true;
      }

      if (shouldEvict) {
        toEvict.push(tailerPath);
      }
    }

    // Await stops outside the iteration to avoid modifying the map during iteration
    for (const tailerPath of toEvict) {
      const tailer = tailers.get(tailerPath);
      if (!tailer) continue;
      const shortId = path.basename(tailerPath, '.jsonl').slice(0, 8);
      console.error(`[engram] Evicting tailer: ${shortId}`);
      try {
        await Promise.race([
          tailer.stop(),
          new Promise(resolve => setTimeout(resolve, 10_000)),
        ]);
      } catch (err) {
        console.error(`[engram] Eviction stop failed: ${(err as Error).message}`);
      }
      tailers.delete(tailerPath);

      // Clean up recollection file
      const evictedSessionId = path.basename(tailerPath, '.jsonl');
      try { fs.unlinkSync(path.join(RECOLLECTIONS_DIR, `${evictedSessionId}.json`)); } catch {}
    }

    // W3: Pass active session IDs to prevent pruning sessions with running tailers
    const activeSessionIds = new Set([...tailers.keys()].map(p => path.basename(p, '.jsonl')));
    stateStore.pruneStale(MAX_FILE_AGE_DAYS, activeSessionIds);

    // Discover and start new sessions
    const freshSessions = discoverSessions();
    for (const jsonlPath of freshSessions) {
      startTailer(jsonlPath); // no-op if already tailing
    }
    // Memory monitoring
    checkMemoryUsage();
    } finally {
      isScanning = false;
    }
  }, SESSION_SCAN_INTERVAL_MS);

  // Cold consolidation (every 4h) — overlap-guarded
  let isConsolidating = false;
  const runConsolidationGuarded = async () => {
    if (isConsolidating) return;
    isConsolidating = true;
    try {
      const result = await runConsolidation(db, openaiClient, embedProvider);
      console.error(`[engram] Cold consolidation: ${result.graduated} graduated, ${result.compressed} compressed`);
    } catch (err) {
      console.error(`[engram] Cold consolidation failed: ${(err as Error).message}`);
    } finally {
      isConsolidating = false;
    }
  };
  // Run first consolidation 60 seconds after startup so short-lived sessions still consolidate
  setTimeout(runConsolidationGuarded, 60_000);
  setInterval(runConsolidationGuarded, COLD_CONSOLIDATION_INTERVAL_MS);

  // Aggressive memory monitoring during startup burst (first 5 min)
  // The normal 60s scan interval is too slow — RSS can spike 300MB in one interval
  const startupMemoryCheck = setInterval(() => {
    checkMemoryUsage();
  }, STARTUP_MEMORY_CHECK_MS);
  setTimeout(() => {
    clearInterval(startupMemoryCheck);
  }, STARTUP_BURST_DURATION_MS);

  console.error(`[engram] Processor running (PID: ${process.pid})`);
}

main().catch(async (err) => {
  console.error(`[engram] Fatal error: ${(err as Error).message}`);
  await shutdown('fatal-error');
});
