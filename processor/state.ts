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
}

interface StateFile {
  sessions: Record<string, SessionState>;
}

const STATE_PATH = path.join(os.homedir(), '.claude-memory', 'engram-state.json');

export class StateStore {
  private state: StateFile = { sessions: {} };
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  load(): void {
    try {
      const raw = fs.readFileSync(STATE_PATH, 'utf-8');
      this.state = JSON.parse(raw);
      console.error(`[state] Loaded state for ${Object.keys(this.state.sessions).length} sessions`);
    } catch {
      // Try .tmp fallback (may be a valid pre-rename state)
      try {
        const raw = fs.readFileSync(STATE_PATH + '.tmp', 'utf-8');
        this.state = JSON.parse(raw);
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
      };
    }
    return this.state.sessions[sessionId];
  }

  updateSession(sessionId: string, patch: Partial<SessionState>): void {
    const current = this.getSession(sessionId);
    Object.assign(current, patch);
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
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

  /** Start periodic saves every 60s */
  startPeriodicSave(): void {
    this.saveTimer = setInterval(() => this.save(), 60_000);
  }

  /** Remove sessions older than maxAgeDays based on last activity */
  pruneStale(maxAgeDays: number): void {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const [sessionId, state] of Object.entries(this.state.sessions)) {
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
    this.save();
  }
}
