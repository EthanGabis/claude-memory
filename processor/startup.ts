// Startup time — shared between index.ts and session-tailer.ts
// to suppress recollections during the initial settling period

export const DAEMON_START_TIME = Date.now();
export const STARTUP_SETTLE_MS = 60_000;
