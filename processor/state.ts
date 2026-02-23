import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Persistent state for crash recovery
// ---------------------------------------------------------------------------

export interface SessionState {
  byteOffset: number;
  lastExtractedAt: number;
  messagesSinceExtraction: number;
  rollingSummary: string;
  lastUserMessageUuid: string;
  createdAt?: number;
  lastBufferSummary: string;
}

interface StateFile {
  sessions: Record<string, SessionState>;
}

const STATE_PATH = path.join(os.homedir(), '.claude-memory', 'engram-state.json');

export class StateStore {
  private state: StateFile = { sessions: {} };
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private debouncedSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // W3: Validate parsed state shape — default to empty if wrong structure
  // W8: Also validate/coerce individual session fields to prevent corrupted data propagation
  private validateState(parsed: unknown): StateFile {
    if (!parsed || typeof parsed !== 'object' || !('sessions' in parsed) ||
        !parsed.sessions || typeof parsed.sessions !== 'object') {
      console.error('[state] Invalid state shape — starting fresh');
      return { sessions: {} };
    }
    // W8: Coerce each session's fields to valid types with safe defaults
    const sessions = parsed.sessions as Record<string, any>;
    const validated: Record<string, SessionState> = {};
    for (const [id, raw] of Object.entries(sessions)) {
      if (!raw || typeof raw !== 'object') continue;
      validated[id] = {
        byteOffset: typeof raw.byteOffset === 'number' && raw.byteOffset >= 0 ? raw.byteOffset : 0,
        lastExtractedAt: typeof raw.lastExtractedAt === 'number' ? raw.lastExtractedAt : Date.now(),
        messagesSinceExtraction: typeof raw.messagesSinceExtraction === 'number' ? raw.messagesSinceExtraction : 0,
        rollingSummary: typeof raw.rollingSummary === 'string' ? raw.rollingSummary : '',
        lastUserMessageUuid: typeof raw.lastUserMessageUuid === 'string' ? raw.lastUserMessageUuid : '',
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
        lastBufferSummary: typeof raw.lastBufferSummary === 'string' ? raw.lastBufferSummary : '',
      };
    }
    return { sessions: validated };
  }

  load(): void {
    try {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8');
      this.state = this.validateState(JSON.parse(raw));
      console.error(`[state] Loaded state for ${Object.keys(this.state.sessions).length} sessions`);
    } catch {
      // Try .tmp fallback (may be a valid pre-rename state)
      try {
        const raw = fs.readFileSync(STATE_PATH + '.tmp', 'utf-8');
        this.state = this.validateState(JSON.parse(raw));
        console.error('[state] Recovered from .tmp fallback');
      } catch {
        this.state = { sessions: {} };
        console.error('[state] No existing state file — starting fresh');
      }
    }
  }

  getSession(sessionId: string): SessionState {
    if (!this.state.sessions[sessionId]) {
      this.state.sessions[sessionId] = {
        byteOffset: 0,
        lastExtractedAt: Date.now(),
        messagesSinceExtraction: 0,
        rollingSummary: '',
        lastUserMessageUuid: '',
        createdAt: Date.now(),
        lastBufferSummary: '',
      };
    }
    return this.state.sessions[sessionId];
  }

  updateSession(sessionId: string, patch: Partial<SessionState>): void {
    const current = this.getSession(sessionId);
    Object.assign(current, patch);
    this.dirty = true;
  }

  /** Schedule a save within 5 seconds (debounced) */
  saveSoon(): void {
    if (this.debouncedSaveTimer) return; // already scheduled
    this.debouncedSaveTimer = setTimeout(() => {
      this.debouncedSaveTimer = null;
      this.save();
    }, 5_000);
  }

  // Fix #7: Concurrent writes prevented by PID file (single daemon instance).
  // Atomic write (tmp + rename) handles crash safety.
  save(): void {
    if (!this.dirty) return;
    if (this.debouncedSaveTimer) {
      clearTimeout(this.debouncedSaveTimer);
      this.debouncedSaveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      const tmp = STATE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmp, STATE_PATH);
      this.dirty = false;
    } catch (err) {
      console.error(`[state] Failed to save: ${(err as Error).message}`);
    }
  }

  /** Start periodic saves every 30s */
  startPeriodicSave(): void {
    this.saveTimer = setInterval(() => this.save(), 30_000);
  }

  /** Remove sessions older than maxAgeDays based on last activity.
   *  W3: Sessions with active tailers are never pruned (prevents offset reset
   *  when extraction fails but the session is still running). */
  pruneStale(maxAgeDays: number, activeSessionIds?: Set<string>): void {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const [sessionId, state] of Object.entries(this.state.sessions)) {
      // W3: Never prune sessions that still have active tailers
      if (activeSessionIds?.has(sessionId)) continue;
      // Clamp future-dated timestamps (e.g. from failure backoff) to now
      const effectiveTime = Math.min(state.lastExtractedAt, Date.now());
      if (effectiveTime < cutoff) {
        delete this.state.sessions[sessionId];
        this.dirty = true;
      }
    }
  }

  /** Stop periodic saves and do a final flush */
  stop(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.debouncedSaveTimer) {
      clearTimeout(this.debouncedSaveTimer);
      this.debouncedSaveTimer = null;
    }
    this.save();
  }
}
