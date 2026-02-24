import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { EmbeddingProvider } from '../mcp/providers.js';
import type { StateStore } from './state.js';
import { extractMemories, upsertEpisode, fetchEpisodeSnapshot, batchEmbedCandidates, type UpsertResult } from './extractor.js';
import { refreshRecollection } from './recollection-writer.js';
import { type ProjectInfo } from '../shared/project-resolver.js';
import { extractFilePathsFromEntry } from '../shared/file-path-extractor.js';
import { inferProjectFromPaths } from '../shared/project-inferrer.js';
import { clearProjectCache } from '../shared/project-resolver.js';
import { upsertProject } from '../shared/project-describer.js';
import { detectParentProject, invalidateFamilyCache } from '../shared/project-family.js';
import { acquireExtractionSlot, releaseExtractionSlot } from './semaphore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BufferedMessage {
  uuid: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface JsonlEntry {
  uuid?: string;
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Content extraction — handles string OR array of blocks
// ---------------------------------------------------------------------------

function extractContent(entry: JsonlEntry): string | null {
  const content = entry.message?.content;
  if (!content) return null;

  if (typeof content === 'string') {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const text = content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text!)
      .join('\n');
    return text.trim() || null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Session Tailer — tails a single JSONL file
// ---------------------------------------------------------------------------

const INITIAL_MESSAGE_THRESHOLD = 5;
const STANDARD_MESSAGE_THRESHOLD = 15;
const WARM_TIME_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes
const RING_BUFFER_MAX = 50;

export class SessionTailer {
  private sessionId: string;
  readonly jsonlPath: string;
  private stateStore: StateStore;
  private embedProvider: EmbeddingProvider;
  private db: Database;
  public projectName: string | null;
  public projectPath: string | null;
  private projectIsRoot: boolean;
  private llmApiKey: string;

  private buffer: BufferedMessage[] = [];
  private extractionBuffer: BufferedMessage[] = [];
  public previousEmbedding: Float32Array | null = null;
  private watcher: fs.FSWatcher | null = null;
  private processing = false;
  private pendingRead = false;
  private stopped = false;
  private pendingLine = '';
  private utf8Decoder = new StringDecoder('utf-8');
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // stoppedDuringProcessing removed (Fix #5) — no longer jumping to EOF on stop
  private hasExtractedOnce = false;
  private extracting = false;
  private extractionPending = false;
  private extractionPromise: Promise<void> | null = null;
  private extractionBackoff = 0;
  private lastExtractionFailure = 0;
  private warmTimerHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private caughtUp = false; // true once initial backlog is fully read
  private static readonly MAX_EXTRACTION_BUFFER = 100;

  // Live re-resolution state
  private observedFilePaths: Set<string> = new Set();
  private hasReResolved = false;
  private readonly RE_RESOLVE_PATH_THRESHOLD = 5;

  // Per-chunk project inference: tracks file paths since last extraction
  private filePathsSinceLastExtraction = new Set<string>();

  constructor(
    jsonlPath: string,
    stateStore: StateStore,
    embedProvider: EmbeddingProvider,
    db: Database,
    llmApiKey: string,
    projectInfo?: ProjectInfo,
  ) {
    this.jsonlPath = jsonlPath;
    this.sessionId = path.basename(jsonlPath, '.jsonl');
    this.stateStore = stateStore;
    this.embedProvider = embedProvider;
    this.db = db;
    this.llmApiKey = llmApiKey;

    // If projectInfo provided, use it for project name; otherwise fall back to path-based detection
    if (projectInfo) {
      this.projectName = projectInfo.name;
      this.projectPath = projectInfo.fullPath ?? null;
      this.projectIsRoot = projectInfo.isRoot;
    } else {
      // Fallback: extract from path (existing behavior)
      const parts = jsonlPath.split(path.sep);
      const projectsIdx = parts.indexOf('projects');
      this.projectName = projectsIdx >= 0 && projectsIdx + 1 < parts.length
        ? parts[projectsIdx + 1]
        : null;
      this.projectPath = null;
      this.projectIsRoot = false;
    }
  }

  /** Public flush — called by daemon UDS handler for session-end extraction */
  async flush(): Promise<void> {
    if (this.extractionBuffer.length > 0) {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Flush: ${this.extractionBuffer.length} buffered messages`);
      await this.extract(true); // W7: force bypasses backoff
    }
  }

  async start(): Promise<void> {
    if (this.started) return; // Fix #8: Idempotent — prevent duplicate watchers/timers
    this.started = true;
    const state = this.stateStore.getSession(this.sessionId);
    console.error(`[tailer:${this.sessionId.slice(0, 8)}] Starting at offset ${state.byteOffset}`);

    // Initial read from saved offset (backlog catch-up — recollections skipped)
    await this.readNewLines();
    this.caughtUp = true; // Now processing live messages — enable recollections

    // Watch for changes using fs.watch (works well with Bun)
    // Debounce at 200ms to prevent rapid-fire kqueue events
    try {
      this.watcher = fs.watch(this.jsonlPath, () => {
        if (this.stopped) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.scheduleRead();
        }, 200);
      });
    } catch (err) {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Watch failed: ${(err as Error).message}`);
    }

    // Fix 2: Periodic warm-time check — ensures 20-min trigger fires even without new user messages
    this.warmTimerHandle = setInterval(() => {
      if (this.stopped) return;
      const s = this.stateStore.getSession(this.sessionId);
      if (this.extractionBuffer.length > 0 && Date.now() - s.lastExtractedAt >= WARM_TIME_THRESHOLD_MS) {
        this.extract().catch(err => {
          console.error(`[tailer:${this.sessionId.slice(0, 8)}] Warm timer extraction error: ${(err as Error).message}`);
        });
      }
    }, 60_000);
  }

  private scheduleRead(): void {
    if (this.processing) {
      this.pendingRead = true;
      return;
    }
    this.readNewLines().catch(err => {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Read error: ${(err as Error).message}`);
    });
  }

  /** Fix 1: Schedule a deferred extraction to avoid stack depth issues */
  private scheduleExtraction(): void {
    setTimeout(() => {
      if (this.stopped) return; // W1: Don't extract after stop
      this.extract().catch(err => {
        console.error(`[tailer:${this.sessionId.slice(0, 8)}] Deferred extraction error: ${(err as Error).message}`);
      });
    }, 0);
  }

  private async readNewLines(): Promise<void> {
    if (this.stopped) return;
    this.processing = true;

    try {
      // Fix #1: Loop to drain backlog > 4MB instead of processing one chunk per trigger
      const MAX_READ_SIZE = 4 * 1024 * 1024; // 4MB per read (M2)
      const MAX_ITERATIONS = 10; // Safety bound to prevent infinite loop

      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const state = this.stateStore.getSession(this.sessionId);

        let stat: fs.Stats;
        try {
          stat = fs.statSync(this.jsonlPath);
        } catch {
          break; // File removed
        }

        // Truncation detection — file was replaced or rotated
        if (stat.size < state.byteOffset) {
          console.error(`[tailer:${this.sessionId.slice(0, 8)}] File truncated — resetting`);
          this.stateStore.updateSession(this.sessionId, { byteOffset: 0 });
          this.pendingLine = '';
          break;
        }

        if (stat.size === state.byteOffset) {
          break; // fully caught up
        }

        // Read new bytes from saved offset with FD safety
        const newSize = stat.size - state.byteOffset;
        const readSize = Math.min(newSize, MAX_READ_SIZE);
        const buf = Buffer.alloc(readSize);
        const fd = fs.openSync(this.jsonlPath, 'r');
        let bytesRead: number;
        try {
          bytesRead = fs.readSync(fd, buf, 0, readSize, state.byteOffset);
        } finally {
          fs.closeSync(fd);
        }

        if (bytesRead === 0) break; // nothing new

        // Partial line handling — prepend any leftover from previous read
        // Use StringDecoder to avoid splitting multi-byte UTF-8 characters (C2)
        const decoded = this.utf8Decoder.write(buf.subarray(0, bytesRead));
        const text = this.pendingLine + decoded;
        const lines = text.split('\n');
        this.pendingLine = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as JsonlEntry;
            await this.processEntry(entry);
          } catch {
            // N1: Log metadata only — avoid leaking user content to logs
            console.error(`[tailer:${this.sessionId.slice(0, 8)}] Malformed JSON line (${line.length} chars)`);
          }
        }

        // Only advance offset by consumed bytes (not pending).
        // StringDecoder may hold back incomplete bytes, so compute from text.
        const consumedText = text.substring(0, text.length - this.pendingLine.length);
        const consumedBytes = Buffer.byteLength(consumedText, 'utf-8');
        this.stateStore.updateSession(this.sessionId, {
          byteOffset: state.byteOffset + consumedBytes,
        });

        // If we read less than MAX_READ_SIZE, we've caught up
        if (readSize < MAX_READ_SIZE) break;
      }
      // C1: If we hit MAX_ITERATIONS but file still has more data, schedule continuation
      // to prevent stalling on large backlogs (>40MB) until the next fs event
      const finalState = this.stateStore.getSession(this.sessionId);
      try {
        const finalStat = fs.statSync(this.jsonlPath);
        if (finalStat.size > finalState.byteOffset) {
          this.pendingRead = true;
        }
      } catch {}
    } finally {
      this.processing = false;
      if (this.pendingRead) {
        this.pendingRead = false;
        this.scheduleRead();
      }
    }
  }

  private async processEntry(entry: JsonlEntry): Promise<void> {
    // Filter: only process user and assistant messages
    const type = entry.type ?? entry.message?.role;
    if (type !== 'user' && type !== 'assistant') return;

    // --- Live re-resolution: track file paths from tool_use blocks ---
    // IMPORTANT: Must run BEFORE content check -- tool_use-only entries have null content
    if (type === 'assistant') {
      const paths = extractFilePathsFromEntry(entry);
      // Always track per-chunk paths for chunk-level project inference
      for (const p of paths) this.filePathsSinceLastExtraction.add(p);
      // Session-level re-resolution (only once)
      if (!this.hasReResolved) {
        for (const p of paths) this.observedFilePaths.add(p);
        if (this.observedFilePaths.size >= this.RE_RESOLVE_PATH_THRESHOLD) {
          this.attemptReResolution();
        }
      }
    }

    const content = extractContent(entry);
    if (!content) return;

    const role = (type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant';
    const rawTs = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    const msg: BufferedMessage = {
      uuid: entry.uuid || randomUUID(),
      role,
      content,
      timestamp: Number.isNaN(rawTs) ? Date.now() : rawTs, // Fix #11: Guard against NaN from invalid timestamps
    };

    // Add to ring buffer (max 50)
    this.buffer.push(msg);
    if (this.buffer.length > RING_BUFFER_MAX) {
      this.buffer.shift();
    }

    // C2: Hard cap on extraction buffer — prevents memory exhaustion when extraction
    // cannot run (missing API key, persistent failures, backoff). Drop oldest messages.
    if (this.extractionBuffer.length >= SessionTailer.MAX_EXTRACTION_BUFFER) {
      this.extractionBuffer.shift();
    }
    this.extractionBuffer.push(msg);

    // Persist buffer summary for crash recovery
    this.stateStore.updateSession(this.sessionId, {
      lastBufferSummary: content.slice(0, 200),
    });

    // On new user message: check warm triggers
    // Recollection now triggered by /recollect HTTP endpoint — see userpromptsubmit hook
    if (role === 'user') {
      // Update state
      const state = this.stateStore.getSession(this.sessionId);
      this.stateStore.updateSession(this.sessionId, {
        messagesSinceExtraction: state.messagesSinceExtraction + 1,
        lastUserMessageUuid: msg.uuid,
      });

      // Check warm-path triggers with adaptive threshold
      const updated = this.stateStore.getSession(this.sessionId);
      const timeSinceLast = Date.now() - updated.lastExtractedAt;
      const threshold = this.hasExtractedOnce ? STANDARD_MESSAGE_THRESHOLD : INITIAL_MESSAGE_THRESHOLD;

      if (updated.messagesSinceExtraction >= threshold || timeSinceLast >= WARM_TIME_THRESHOLD_MS) {
        await this.extract();
      }
    }
  }

  /**
   * Attempt to re-resolve the project from observed file paths.
   * Only upgrades: null/root -> specific project. Never downgrades.
   * Only runs once per session to avoid flip-flopping.
   */
  private attemptReResolution(): void {
    if (this.hasReResolved) return;
    this.hasReResolved = true; // Only try once

    // Only re-resolve if current project is null or root
    if (this.projectName && !this.projectIsRoot) return;

    const inferred = inferProjectFromPaths([...this.observedFilePaths]);
    if (!inferred || !inferred.name || inferred.isRoot) return;

    const oldProject = this.projectName;
    const oldIsRoot = this.projectIsRoot;
    this.projectName = inferred.name;
    this.projectPath = inferred.fullPath ?? null;
    this.projectIsRoot = false;

    // Invalidate resolver cache so future reads get the corrected project
    clearProjectCache();

    // Register the discovered project in the projects table
    if (inferred.fullPath) {
      try {
        const parentProject = detectParentProject(this.db, inferred.fullPath);
        upsertProject(this.db, inferred.name, inferred.fullPath, parentProject);
        invalidateFamilyCache();
      } catch {}
    }

    console.error(
      `[tailer:${this.sessionId.slice(0, 8)}] Re-resolved project: "${oldProject}" (root=${oldIsRoot}) -> "${inferred.name}"`
    );

    // Re-scope already-extracted global episodes from this session
    try {
      const result = this.db.prepare(
        `UPDATE episodes SET project = ?, project_path = ?, scope = 'project'
         WHERE session_id = ? AND scope = 'global'`
      ).run(inferred.name, inferred.fullPath ?? null, this.sessionId);
      const changes = (result as any).changes ?? 0;
      if (changes > 0) {
        console.error(
          `[tailer:${this.sessionId.slice(0, 8)}] Re-scoped ${changes} episodes to project "${inferred.name}"`
        );
      }
    } catch (err) {
      console.error(
        `[tailer:${this.sessionId.slice(0, 8)}] Re-scope failed: ${(err as Error).message}`
      );
    }
  }

  private async extract(force?: boolean): Promise<void> {
    if (this.extractionBuffer.length === 0) return;
    // W1: Don't start new extractions after stop (unless forced by flush/stop)
    if (this.stopped && !force) return;

    // Fix 1: If already extracting, mark pending instead of silently dropping
    if (this.extracting) {
      this.extractionPending = true;
      return;
    }

    // Check backoff period — bypassed when force=true (W7: flush/stop must always extract)
    if (!force && this.extractionBackoff > 0 && Date.now() - this.lastExtractionFailure < this.extractionBackoff) {
      return;
    }

    if (!this.llmApiKey) {
      // Fix #3: Don't clear buffer — preserve messages for retry when key becomes available
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] No API key — skipping extraction (buffer preserved)`);
      return;
    }

    this.extracting = true;

    // Fix 3: Store the extraction promise so stop() can await it
    this.extractionPromise = (async () => {
      // Acquire global extraction semaphore — limits concurrent API calls
      await acquireExtractionSlot();
      try {
      // Fix #2: Snapshot buffer length — messages added during async extraction are preserved
      const bufferLen = this.extractionBuffer.length;
      const snapshot = this.extractionBuffer.slice(0, bufferLen);
      const state = this.stateStore.getSession(this.sessionId);
      const messages = snapshot.map(m => ({
        role: m.role,
        content: m.content,
      }));

      // Per-chunk project inference: if session is from a root/parent directory,
      // infer which child project this chunk references from file paths
      let chunkProjectName = this.projectName;
      let chunkProjectPath = this.projectPath;
      let chunkIsRoot = this.projectIsRoot;

      if (this.projectIsRoot && this.filePathsSinceLastExtraction.size >= 2) {
        const inferred = inferProjectFromPaths([...this.filePathsSinceLastExtraction]);
        if (inferred && inferred.name && inferred.fullPath && !inferred.isRoot) {
          chunkProjectName = inferred.name;
          chunkProjectPath = inferred.fullPath;
          chunkIsRoot = false;
          console.error(
            `[tailer:${this.sessionId.slice(0, 8)}] Chunk inferred project: "${inferred.name}"`
          );
        }
      }

      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Extracting from ${messages.length} messages`);

      try {
        const result = await extractMemories(
          state.rollingSummary,
          messages,
          chunkProjectName,
          this.llmApiKey,
          chunkIsRoot,
        );

        const episodeSnapshot = fetchEpisodeSnapshot(this.db, chunkProjectName);

        // W6: Batch-embed all candidate summaries in one call (avoids N+1)
        let candidateEmbeddings: (Buffer | null)[] = [];
        try {
          candidateEmbeddings = await batchEmbedCandidates(result.memories, this.embedProvider);
        } catch (err) {
          console.error(`[tailer:${this.sessionId.slice(0, 8)}] Batch embed failed: ${(err as Error).message}`);
          candidateEmbeddings = result.memories.map(() => null);
        }

        let added = 0;
        let updated = 0;
        for (let i = 0; i < result.memories.length; i++) {
          const candidate = result.memories[i];
          try {
            const upsertResult = await upsertEpisode(
              candidate,
              this.sessionId,
              chunkProjectName,
              chunkIsRoot,
              this.embedProvider,
              this.db,
              episodeSnapshot,
              candidateEmbeddings[i],
              chunkProjectPath,
            );
            if (upsertResult.action === 'add') {
              added++;
              if (upsertResult.embedding) {
                let effectiveScope = candidate.scope;
                if (chunkProjectName && !chunkIsRoot && candidate.scope === 'global') {
                  effectiveScope = 'project';
                }
                if (!chunkProjectName || chunkIsRoot) {
                  effectiveScope = 'global';
                }
                episodeSnapshot.push({
                  id: upsertResult.id!,
                  summary: candidate.summary,
                  full_content: candidate.full_content,
                  entities: JSON.stringify(candidate.entities),
                  embedding: upsertResult.embedding,
                  access_count: 0,
                  scope: effectiveScope,
                  project: effectiveScope === 'project' ? chunkProjectName : null,
                });
              }
            }
            if (upsertResult.action === 'update') {
              updated++;
              if (upsertResult.id && upsertResult.embedding) {
                const existing = episodeSnapshot.find(e => e.id === upsertResult.id);
                if (existing) existing.embedding = upsertResult.embedding;
              }
            }
          } catch (err) {
            console.error(`[tailer] upsertEpisode failed: ${(err as Error).message}`);
          }
        }

        console.error(`[tailer:${this.sessionId.slice(0, 8)}] Extraction: ${added} added, ${updated} updated`);

        // Wire refreshRecollection after successful extraction
        // Skip during backlog catch-up — no active session is listening
        const lastUserMsg = this.caughtUp ? [...snapshot].reverse().find(m => m.role === 'user') : null;
        if (lastUserMsg) {
          try {
            const refreshResult = await refreshRecollection(
              this.sessionId,
              lastUserMsg.content,
              lastUserMsg.uuid,
              this.projectName,
              null, // null forces topic gate bypass
              this.embedProvider,
              this.db,
              this.projectPath,
            );
            this.previousEmbedding = refreshResult.embedding;
          } catch (err) {
            console.error(`[tailer:${this.sessionId.slice(0, 8)}] Refresh recollection error: ${(err as Error).message}`);
          }
        }

        // SUCCESS: reset backoff, splice only processed messages (Fix #2)
        this.extractionBackoff = 0;
        this.extractionBuffer.splice(0, bufferLen);
        this.filePathsSinceLastExtraction.clear();
        this.hasExtractedOnce = true;
        this.stateStore.updateSession(this.sessionId, {
          lastExtractedAt: Date.now(),
          messagesSinceExtraction: 0,
          rollingSummary: result.updatedSummary,
        });
      } catch (err) {
        // FAILURE: keep buffer, set exponential backoff (15s -> 30s -> 60s -> 120s max)
        this.lastExtractionFailure = Date.now();
        this.extractionBackoff = this.extractionBackoff === 0
          ? 15_000
          : Math.min(this.extractionBackoff * 2, 120_000);
        // Cap per-chunk path cache to prevent unbounded growth during persistent failures
        if (this.filePathsSinceLastExtraction.size > 1000) {
          this.filePathsSinceLastExtraction.clear();
        }
        console.error(`[tailer:${this.sessionId.slice(0, 8)}] Extraction failed, retry in ${this.extractionBackoff / 1000}s: ${(err as Error).message}`);
      }
      } finally {
        releaseExtractionSlot();
      }
    })();

    try {
      await this.extractionPromise;
    } finally {
      this.extracting = false;
      this.extractionPromise = null;

      // Fix 1: If extraction was requested while we were busy, schedule it now
      if (this.extractionPending) {
        this.extractionPending = false;
        this.scheduleExtraction();
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // W2: Flush remaining bytes from decoder and process any pending final line
    const trailing = this.utf8Decoder.end();
    if (trailing) this.pendingLine += trailing;
    if (this.pendingLine.trim()) {
      try {
        const entry = JSON.parse(this.pendingLine) as JsonlEntry;
        await this.processEntry(entry);
      } catch {
        // Incomplete final line — ignore
      }
      this.pendingLine = '';
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Fix 2: Clear the warm timer interval
    if (this.warmTimerHandle) {
      clearInterval(this.warmTimerHandle);
      this.warmTimerHandle = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Fix 3: Session-end flush — await in-flight extraction or start new one
    if (this.extractionPromise) {
      // Extraction already in flight — wait for it (with 10s timeout)
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Waiting for in-flight extraction on stop`);
      await Promise.race([
        this.extractionPromise,
        new Promise(resolve => setTimeout(resolve, 10_000)),
      ]);
    }
    // C2: Re-check buffer after awaiting in-flight extraction — messages may have
    // arrived between the extraction snapshot and its completion
    if (this.extractionBuffer.length > 0) {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Flushing ${this.extractionBuffer.length} messages on stop`);
      await Promise.race([
        this.extract(true), // W7: force bypasses backoff
        new Promise(resolve => setTimeout(resolve, 10_000)),
      ]);
    }

    // Fix #5: Don't jump to EOF — offset stays at last consumed position.
    // Reprocessing on restart is safe (extraction dedup handles duplicates).
    this.stateStore.saveSoon();
  }
}
