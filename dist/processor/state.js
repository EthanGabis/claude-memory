import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const STATE_PATH = path.join(os.homedir(), '.claude-memory', 'engram-state.json');
export class StateStore {
    state = { sessions: {} };
    dirty = false;
    saveTimer = null;
    load() {
        try {
            const raw = fs.readFileSync(STATE_PATH, 'utf-8');
            this.state = JSON.parse(raw);
            console.error(`[state] Loaded state for ${Object.keys(this.state.sessions).length} sessions`);
        }
        catch {
            this.state = { sessions: {} };
            console.error('[state] No existing state file — starting fresh');
        }
    }
    getSession(sessionId) {
        if (!this.state.sessions[sessionId]) {
            this.state.sessions[sessionId] = {
                byteOffset: 0,
                lastExtractedAt: Date.now(),
                messagesSinceExtraction: 0,
                rollingSummary: '',
                lastUserMessageUuid: '',
            };
        }
        return this.state.sessions[sessionId];
    }
    updateSession(sessionId, patch) {
        const current = this.getSession(sessionId);
        Object.assign(current, patch);
        this.dirty = true;
    }
    save() {
        if (!this.dirty)
            return;
        try {
            fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
            const tmp = STATE_PATH + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
            fs.renameSync(tmp, STATE_PATH);
            this.dirty = false;
        }
        catch (err) {
            console.error(`[state] Failed to save: ${err.message}`);
        }
    }
    /** Start periodic saves every 60s */
    startPeriodicSave() {
        this.saveTimer = setInterval(() => this.save(), 60_000);
    }
    /** Remove sessions older than maxAgeDays based on last activity */
    pruneStale(maxAgeDays) {
        const cutoff = Date.now() - maxAgeDays * 86_400_000;
        for (const [sessionId, state] of Object.entries(this.state.sessions)) {
            if (state.lastExtractedAt < cutoff) {
                delete this.state.sessions[sessionId];
                this.dirty = true;
            }
        }
    }
    /** Stop periodic saves and do a final flush */
    stop() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        this.save();
    }
}
