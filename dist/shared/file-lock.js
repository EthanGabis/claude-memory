import fs from 'node:fs';
const LOCK_TIMEOUT = 5000;
const RETRY_INTERVAL = 50;
export async function withFileLock(lockPath, fn) {
    let deadline = Date.now() + LOCK_TIMEOUT;
    while (true) {
        try {
            // O_EXCL ensures atomic create — fails if file exists
            const fd = fs.openSync(lockPath, 'wx');
            // Write our PID into the lock file
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            break;
        }
        catch {
            // Lock file exists — check if stale
            if (Date.now() > deadline) {
                // Try to read the owner PID
                let ownerAlive = false;
                try {
                    const pidStr = fs.readFileSync(lockPath, 'utf-8').trim();
                    const pid = parseInt(pidStr, 10);
                    if (!isNaN(pid)) {
                        try {
                            process.kill(pid, 0); // signal 0 = check if alive
                            ownerAlive = true;
                        }
                        catch {
                            // PID is dead
                        }
                    }
                }
                catch {
                    // Can't read lock file — treat as stale
                }
                if (!ownerAlive) {
                    try {
                        fs.unlinkSync(lockPath);
                    }
                    catch { }
                    // Reset deadline so full retry window is available after stale removal
                    deadline = Date.now() + LOCK_TIMEOUT;
                }
                await new Promise(r => setTimeout(r, RETRY_INTERVAL));
                // If owner is alive, we keep retrying (new deadline not reset — will eventually throw)
                if (ownerAlive) {
                    throw new Error(`Lock ${lockPath} held by live process after timeout`);
                }
                continue;
            }
            await new Promise(r => setTimeout(r, RETRY_INTERVAL));
        }
    }
    try {
        return await fn();
    }
    finally {
        try {
            fs.unlinkSync(lockPath);
        }
        catch { }
    }
}
