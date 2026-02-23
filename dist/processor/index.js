import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { LocalGGUFProvider } from '../mcp/providers.js';
import { StateStore } from './state.js';
import { SessionTailer } from './session-tailer.js';
import { runConsolidation } from './consolidator.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PID_PATH = path.join(os.homedir(), '.claude-memory', 'engram.pid');
const MEMORY_WARN_MB = 400;
const MEMORY_RESTART_MB = 512;
const SESSION_SCAN_INTERVAL_MS = 60_000;
const COLD_CONSOLIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_FILE_AGE_DAYS = 7;
// ---------------------------------------------------------------------------
// PID file management (atomic: O_CREAT | O_EXCL)
// ---------------------------------------------------------------------------
let pidFd = null;
function acquirePidFile() {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            pidFd = fs.openSync(PID_PATH, 'wx');
            fs.writeSync(pidFd, String(process.pid));
            return true;
        }
        catch {
            // PID file exists — check if owner is alive
            try {
                const pidStr = fs.readFileSync(PID_PATH, 'utf-8').trim();
                const pid = parseInt(pidStr, 10);
                if (!isNaN(pid)) {
                    try {
                        process.kill(pid, 0);
                        return false; // Another instance is genuinely running
                    }
                    catch {
                        // PID is dead — stale file
                    }
                }
            }
            catch {
                // Can't read PID file
            }
            // Remove stale PID file and retry
            try {
                fs.unlinkSync(PID_PATH);
            }
            catch { }
        }
    }
    return false; // Failed after max retries
}
function removePidFile() {
    if (pidFd !== null) {
        try {
            fs.closeSync(pidFd);
        }
        catch { }
        pidFd = null;
    }
    try {
        fs.unlinkSync(PID_PATH);
    }
    catch { }
}
// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------
function discoverSessions() {
    const sessions = [];
    const cutoff = Date.now() - MAX_FILE_AGE_DAYS * 86_400_000;
    try {
        // Scan ~/.claude/projects/*/*.jsonl
        const projectEntries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
        for (const projectDir of projectEntries) {
            if (!projectDir.isDirectory())
                continue;
            const projectPath = path.join(PROJECTS_DIR, projectDir.name);
            try {
                const files = fs.readdirSync(projectPath, { withFileTypes: true });
                for (const file of files) {
                    if (!file.name.endsWith('.jsonl'))
                        continue;
                    if (!file.isFile())
                        continue;
                    const filePath = path.join(projectPath, file.name);
                    // Exclude subagents
                    if (filePath.includes('/subagents/'))
                        continue;
                    // Filter by modification time
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.mtimeMs >= cutoff) {
                            sessions.push(filePath);
                        }
                    }
                    catch {
                        // stat failed — skip
                    }
                }
            }
            catch {
                // Can't read project directory — skip
            }
        }
    }
    catch {
        console.error('[engram] Could not read projects directory');
    }
    return sessions;
}
// ---------------------------------------------------------------------------
// Memory monitoring
// ---------------------------------------------------------------------------
function checkMemoryUsage() {
    const usage = process.memoryUsage();
    const rssMB = usage.rss / (1024 * 1024);
    if (rssMB >= MEMORY_RESTART_MB) {
        console.error(`[engram] Memory usage ${rssMB.toFixed(0)}MB exceeds ${MEMORY_RESTART_MB}MB — restarting`);
        shutdown('memory-limit');
    }
    else if (rssMB >= MEMORY_WARN_MB) {
        console.error(`[engram] Memory usage warning: ${rssMB.toFixed(0)}MB (limit: ${MEMORY_RESTART_MB}MB)`);
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let db;
let stateStore;
const tailers = new Map();
let chokidarWatcher = null;
let shutdownInProgress = false;
async function shutdown(reason) {
    if (shutdownInProgress)
        return;
    shutdownInProgress = true;
    console.error(`[engram] Shutting down (${reason})...`);
    // Stop all tailers
    for (const [id, tailer] of tailers) {
        tailer.stop();
    }
    tailers.clear();
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
        }
        catch {
            // Already closed
        }
    }
    // Remove PID file
    removePidFile();
    console.error('[engram] Shutdown complete');
    process.exit(reason === 'memory-limit' ? 1 : 0);
}
function startTailer(jsonlPath) {
    const sessionId = path.basename(jsonlPath, '.jsonl');
    if (tailers.has(sessionId))
        return;
    const llmApiKey = process.env.OPENAI_API_KEY ?? '';
    const tailer = new SessionTailer(jsonlPath, stateStore, embedProvider, db, llmApiKey);
    tailers.set(sessionId, tailer);
    tailer.start().catch(err => {
        console.error(`[engram] Failed to start tailer for ${sessionId.slice(0, 8)}: ${err.message}`);
        tailers.delete(sessionId);
    });
}
// Global embed provider — initialized in main()
let embedProvider;
async function main() {
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
    }
    catch (err) {
        console.error(`[engram] Embedding model failed to load: ${err.message}`);
        console.error('[engram] Continuing without embeddings — recollections will be limited');
    }
    // 4. Open SQLite DB (WAL mode, busy_timeout=5000 — set by initDb)
    db = initDb(DB_PATH);
    console.error('[engram] Database ready');
    // 5. Load persistent state
    stateStore = new StateStore();
    stateStore.load();
    stateStore.startPeriodicSave();
    // 6. Discover active sessions
    const sessions = discoverSessions();
    console.error(`[engram] Discovered ${sessions.length} active sessions`);
    for (const jsonlPath of sessions) {
        startTailer(jsonlPath);
    }
    // 7. Watch for new JSONL files with chokidar
    try {
        const chokidar = await import('chokidar');
        chokidarWatcher = chokidar.watch(PROJECTS_DIR, {
            depth: 1, // only watch project-hash dirs, not deep subdirs
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: { stabilityThreshold: 500 },
        });
        chokidarWatcher.on('add', (filePath) => {
            if (!filePath.endsWith('.jsonl'))
                return;
            if (filePath.includes('/subagents/'))
                return;
            console.error(`[engram] New session detected: ${path.basename(filePath, '.jsonl').slice(0, 8)}`);
            startTailer(filePath);
        });
        console.error('[engram] Watching for new sessions');
    }
    catch (err) {
        console.error(`[engram] Chokidar watch failed: ${err.message}`);
    }
    // 8. Periodic tasks
    // Session scan + tailer eviction every 60s
    setInterval(() => {
        // Evict stale/missing tailers
        for (const [id, tailer] of tailers) {
            try {
                const stat = fs.statSync(tailer.jsonlPath);
                if (Date.now() - stat.mtimeMs > MAX_FILE_AGE_DAYS * 86_400_000) {
                    console.error(`[engram] Evicting stale tailer: ${id.slice(0, 8)}`);
                    tailer.stop();
                    tailers.delete(id);
                }
            }
            catch {
                console.error(`[engram] Evicting missing tailer: ${id.slice(0, 8)}`);
                tailer.stop();
                tailers.delete(id);
            }
        }
        // Prune stale state entries that no longer have active sessions
        stateStore.pruneStale(MAX_FILE_AGE_DAYS);
        // Discover and start new sessions
        const freshSessions = discoverSessions();
        for (const jsonlPath of freshSessions) {
            startTailer(jsonlPath); // no-op if already tailing
        }
        // Memory monitoring
        checkMemoryUsage();
    }, SESSION_SCAN_INTERVAL_MS);
    // Cold consolidation (every 4h) — overlap-guarded
    let isConsolidating = false;
    setInterval(async () => {
        if (isConsolidating)
            return;
        isConsolidating = true;
        try {
            const result = await runConsolidation(db);
            console.error(`[engram] Cold consolidation: ${result.graduated} graduated, ${result.compressed} compressed`);
        }
        catch (err) {
            console.error(`[engram] Cold consolidation failed: ${err.message}`);
        }
        finally {
            isConsolidating = false;
        }
    }, COLD_CONSOLIDATION_INTERVAL_MS);
    console.error(`[engram] Processor running (PID: ${process.pid})`);
}
main().catch(async (err) => {
    console.error(`[engram] Fatal error: ${err.message}`);
    await shutdown('fatal-error');
});
