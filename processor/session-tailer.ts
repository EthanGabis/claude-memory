import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { EmbeddingProvider } from '../mcp/providers.js';
import type { StateStore } from './state.js';
import { extractMemories, upsertEpisode, fetchEpisodeSnapshot, type UpsertResult } from './extractor.js';
import { writeRecollections } from './recollection-writer.js';

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

const WARM_MESSAGE_THRESHOLD = 15;
const WARM_TIME_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes
const RING_BUFFER_MAX = 50;

export class SessionTailer {
  private sessionId: string;
  readonly jsonlPath: string;
  private stateStore: StateStore;
  private embedProvider: EmbeddingProvider;
  private db: Database;
  private projectName: string | null;
  private llmApiKey: string;

  private buffer: BufferedMessage[] = [];
  private extractionBuffer: BufferedMessage[] = [];
  private previousEmbedding: Float32Array | null = null;
  private watcher: fs.FSWatcher | null = null;
  private processing = false;
  private pendingRead = false;
  private stopped = false;
  private pendingLine = '';
  private utf8Decoder = new StringDecoder('utf-8');
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stoppedDuringProcessing = false;

  constructor(
    jsonlPath: string,
    stateStore: StateStore,
    embedProvider: EmbeddingProvider,
    db: Database,
    llmApiKey: string,
  ) {
    this.jsonlPath = jsonlPath;
    this.sessionId = path.basename(jsonlPath, '.jsonl');
    this.stateStore = stateStore;
    this.embedProvider = embedProvider;
    this.db = db;
    this.llmApiKey = llmApiKey;

    // Extract project name from path: ~/.claude/projects/<project-hash>/<session>.jsonl
    const parts = jsonlPath.split(path.sep);
    const projectsIdx = parts.indexOf('projects');
    this.projectName = projectsIdx >= 0 && projectsIdx + 1 < parts.length
      ? parts[projectsIdx + 1]
      : null;
  }

  async start(): Promise<void> {
    const state = this.stateStore.getSession(this.sessionId);
    console.error(`[tailer:${this.sessionId.slice(0, 8)}] Starting at offset ${state.byteOffset}`);

    // Initial read from saved offset
    await this.readNewLines();

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

  private async readNewLines(): Promise<void> {
    if (this.stopped) return;
    this.processing = true;

    try {
      const state = this.stateStore.getSession(this.sessionId);
      const stat = fs.statSync(this.jsonlPath);

      // Truncation detection — file was replaced or rotated
      if (stat.size < state.byteOffset) {
        console.error(`[tailer:${this.sessionId.slice(0, 8)}] File truncated — resetting`);
        this.stateStore.updateSession(this.sessionId, { byteOffset: 0 });
        this.pendingLine = '';
        return;
      }

      if (stat.size === state.byteOffset) {
        return; // no new data
      }

      // Read new bytes from saved offset with FD safety
      const newSize = stat.size - state.byteOffset;
      const MAX_READ_SIZE = 4 * 1024 * 1024; // 4MB per read (M2)
      const readSize = Math.min(newSize, MAX_READ_SIZE);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(this.jsonlPath, 'r');
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, buf, 0, readSize, state.byteOffset);
      } finally {
        fs.closeSync(fd);
      }

      if (bytesRead === 0) return; // nothing new

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
          // Malformed JSON line — skip
        }
      }

      // Only advance offset by consumed bytes (not pending).
      // StringDecoder may hold back incomplete bytes, so compute from text.
      const consumedText = text.substring(0, text.length - this.pendingLine.length);
      const consumedBytes = Buffer.byteLength(consumedText, 'utf-8');
      this.stateStore.updateSession(this.sessionId, {
        byteOffset: state.byteOffset + consumedBytes,
      });
    } finally {
      this.processing = false;
      // M4: If stop() was called while we were processing, save final offset now
      if (this.stoppedDuringProcessing) {
        try {
          const stat = fs.statSync(this.jsonlPath);
          this.stateStore.updateSession(this.sessionId, { byteOffset: stat.size });
        } catch {
          // File may have been removed
        }
      }
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

    const content = extractContent(entry);
    if (!content) return;

    const role = (type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant';
    const msg: BufferedMessage = {
      uuid: entry.uuid || randomUUID(),
      role,
      content,
      timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
    };

    // Add to ring buffer (max 50)
    this.buffer.push(msg);
    if (this.buffer.length > RING_BUFFER_MAX) {
      this.buffer.shift();
    }

    // Also track for extraction
    this.extractionBuffer.push(msg);

    // On new user message: trigger recollection + check warm triggers
    if (role === 'user') {
      // Trigger recollection writer
      try {
        const result = await writeRecollections(
          this.sessionId,
          content,
          msg.uuid,
          this.projectName,
          this.previousEmbedding,
          this.embedProvider,
          this.db,
        );
        this.previousEmbedding = result.embedding;
      } catch (err) {
        console.error(`[tailer:${this.sessionId.slice(0, 8)}] Recollection error: ${(err as Error).message}`);
      }

      // Update state
      const state = this.stateStore.getSession(this.sessionId);
      this.stateStore.updateSession(this.sessionId, {
        messagesSinceExtraction: state.messagesSinceExtraction + 1,
        lastUserMessageUuid: msg.uuid,
      });

      // Check warm-path triggers
      const updated = this.stateStore.getSession(this.sessionId);
      const timeSinceLast = Date.now() - updated.lastExtractedAt;

      if (
        updated.messagesSinceExtraction >= WARM_MESSAGE_THRESHOLD ||
        timeSinceLast >= WARM_TIME_THRESHOLD_MS
      ) {
        await this.extract();
      }
    }
  }

  private async extract(): Promise<void> {
    if (this.extractionBuffer.length === 0) return;
    if (!this.llmApiKey) {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] No API key — skipping extraction`);
      this.extractionBuffer = [];
      this.stateStore.updateSession(this.sessionId, {
        messagesSinceExtraction: 0,
      });
      return;
    }

    const state = this.stateStore.getSession(this.sessionId);
    const messages = this.extractionBuffer.map(m => ({
      role: m.role,
      content: m.content,
    }));

    console.error(`[tailer:${this.sessionId.slice(0, 8)}] Extracting from ${messages.length} messages`);

    try {
      const result = await extractMemories(
        state.rollingSummary,
        messages,
        this.projectName,
        this.llmApiKey,
      );

      // Fetch episode snapshot ONCE for the entire batch (avoids N full-table scans)
      const episodeSnapshot = fetchEpisodeSnapshot(this.db, this.projectName);

      // Upsert each candidate memory
      let added = 0;
      let updated = 0;
      for (const candidate of result.memories) {
        try {
          const upsertResult = await upsertEpisode(
            candidate,
            this.sessionId,
            this.projectName,
            this.embedProvider,
            this.db,
            episodeSnapshot,
          );
          if (upsertResult.action === 'add') {
            added++;
            // Push into snapshot so subsequent candidates see this new episode
            if (upsertResult.embedding) {
              episodeSnapshot.push({
                id: upsertResult.id!,
                summary: candidate.summary,
                entities: JSON.stringify(candidate.entities),
                embedding: upsertResult.embedding,
                access_count: 0,
              });
            }
          }
          // C3: Handle update case — refresh snapshot embedding
          if (upsertResult.action === 'update') {
            updated++;
            if (upsertResult.id && upsertResult.embedding) {
              const existing = episodeSnapshot.find(e => e.id === upsertResult.id);
              if (existing) existing.embedding = upsertResult.embedding;
            }
          }
        } catch (err) {
          console.error(`[tailer] upsertEpisode failed for candidate: ${(err as Error).message}`);
          // Continue with next candidate
        }
      }

      console.error(
        `[tailer:${this.sessionId.slice(0, 8)}] Extraction complete: ${added} added, ${updated} updated`,
      );

      // Reset extraction state
      this.extractionBuffer = [];
      this.stateStore.updateSession(this.sessionId, {
        lastExtractedAt: Date.now(),
        messagesSinceExtraction: 0,
        rollingSummary: result.updatedSummary,
      });
    } catch (err) {
      console.error(`[tailer:${this.sessionId.slice(0, 8)}] Extraction failed: ${(err as Error).message}`);
      // Backoff: set lastExtractedAt 5 minutes in the future to prevent
      // every subsequent user message from retrying the API.
      // Clear extraction buffer and reset counter to prevent unbounded growth.
      this.extractionBuffer = [];
      this.stateStore.updateSession(this.sessionId, {
        lastExtractedAt: Date.now() + 300_000,
        messagesSinceExtraction: 0,
      });
    }
  }

  stop(): void {
    this.stopped = true;
    // M4: Flag so readNewLines() finally block can save offset
    this.stoppedDuringProcessing = this.processing;
    // C2: Flush any incomplete multi-byte characters held by the decoder
    this.utf8Decoder.end();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    // Save current byte offset only when no read is in progress
    // to avoid racing with readNewLines() on byteOffset
    if (!this.processing) {
      try {
        const stat = fs.statSync(this.jsonlPath);
        this.stateStore.updateSession(this.sessionId, {
          byteOffset: stat.size,
        });
      } catch {
        // File may have been removed
      }
    }
  }
}
