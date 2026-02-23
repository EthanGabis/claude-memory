import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const LOCK_TIMEOUT = 15000;
const RETRY_INTERVAL = 50;

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let deadline = Date.now() + LOCK_TIMEOUT;
  let lockFd: number | null = null;
  // Unique token per acquisition — prevents same-process concurrent callers from
  // accidentally releasing each other's lock (PID alone is not unique within a process)
  const token = `${process.pid}-${randomUUID()}`;

  while (true) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, token);
      // Keep fd open — proves ownership
      break;
    } catch (err: any) {
      // W1: Only retry on EEXIST (lock contention); rethrow permission/path errors immediately
      if (err?.code && err.code !== 'EEXIST') {
        throw err;
      }
      if (Date.now() > deadline) {
        // Check if lock is stale
        let ownerAlive = false;
        try {
          const content = fs.readFileSync(lockPath, 'utf-8').trim();
          const pid = parseInt(content.split('-')[0], 10);
          if (!isNaN(pid)) {
            try { process.kill(pid, 0); ownerAlive = true; } catch {}
          }
        } catch {}

        if (!ownerAlive) {
          try { fs.unlinkSync(lockPath); } catch {}
          // N2: Reset deadline after reclaiming a stale lock — gives a full
          // timeout window for the next acquisition attempt
          deadline = Date.now() + LOCK_TIMEOUT;
          await new Promise(r => setTimeout(r, RETRY_INTERVAL));
          continue;
        }
        // Owner is alive — give up
        throw new Error(`Lock ${lockPath} held by live process after timeout`);
      }
      await new Promise(r => setTimeout(r, RETRY_INTERVAL));
    }
  }

  try {
    return await fn();
  } finally {
    // Close our fd first
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
    }
    // Only unlink if it's still our lock (check unique token)
    try {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      if (content === token) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}
