import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from 'bun:sqlite';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { LocalGGUFProvider } from '../mcp/providers.js';
import { StateStore } from './state.js';
import { SessionTailer } from './session-tailer.js';
import { runConsolidation } from './consolidator.js';
import { createEngramServer, SOCKET_PATH } from '../shared/uds.js';
import { resolveProjectFromJsonlPath } from '../shared/project-resolver.js';

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
let udsServer: ReturnType<typeof createEngramServer> | null = null;
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

  // Close UDS server
  if (udsServer) {
    udsServer.close();
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
  const tailer = new SessionTailer(jsonlPath, stateStore, embedProvider, db, llmApiKey, projectInfo);
  tailers.set(jsonlPath, tailer);

  tailer.start().catch(err => {
    console.error(`[engram] Failed to start tailer for ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    tailers.delete(jsonlPath);
  });
}

// Global embed provider — initialized in main()
let embedProvider: LocalGGUFProvider;

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

  // 5. Load persistent state
  stateStore = new StateStore();
  stateStore.load();
  stateStore.startPeriodicSave();

  // 5.5. Start UDS listener for hook-to-daemon communication
  udsServer = createEngramServer(SOCKET_PATH, async (msg) => {
    if (msg.event === 'flush' && msg.sessionId) {
      for (const [tailerPath, tailer] of tailers) {
        if (path.basename(tailerPath, '.jsonl') === msg.sessionId) {
          console.error(`[uds] Flush requested for session ${msg.sessionId.slice(0, 8)}`);
          try {
            await tailer.flush();
          } catch (err: any) {
            console.error('[uds] flush failed:', err.message);
          }
          break;
        }
      }
    }
  });
  console.error('[engram] UDS listener ready');

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
  setInterval(async () => {
    if (isConsolidating) return;
    isConsolidating = true;
    try {
      const result = await runConsolidation(db);
      console.error(`[engram] Cold consolidation: ${result.graduated} graduated, ${result.compressed} compressed`);
    } catch (err) {
      console.error(`[engram] Cold consolidation failed: ${(err as Error).message}`);
    } finally {
      isConsolidating = false;
    }
  }, COLD_CONSOLIDATION_INTERVAL_MS);

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
