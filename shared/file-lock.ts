import fs from 'node:fs';

const LOCK_TIMEOUT = 5000;
const RETRY_INTERVAL = 50;

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let deadline = Date.now() + LOCK_TIMEOUT;
  let lockFd: number | null = null;

  while (true) {
    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, String(process.pid));
      // Keep fd open — proves ownership
      break;
    } catch {
      if (Date.now() > deadline) {
        // Check if lock is stale
        let ownerAlive = false;
        try {
          const pidStr = fs.readFileSync(lockPath, 'utf-8').trim();
          const pid = parseInt(pidStr, 10);
          if (!isNaN(pid)) {
            try { process.kill(pid, 0); ownerAlive = true; } catch {}
          }
        } catch {}

        if (!ownerAlive) {
          try { fs.unlinkSync(lockPath); } catch {}
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
    // Only unlink if it's still our lock (check PID)
    try {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      if (content === String(process.pid)) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  }
}
