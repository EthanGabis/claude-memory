import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SOCKET_PATH = path.join(os.homedir(), '.claude-memory', 'engram.sock');
const CONNECT_TIMEOUT = 2000;
const CONNECTION_TIMEOUT = 10_000; // 10s idle timeout per server connection
const MAX_DATA_BYTES = 64 * 1024; // 64KB data limit per server connection

/**
 * UDS Server -- used by the Engram daemon.
 * Listens on socketPath, reads one JSON line per connection, calls handler.
 */
export function createEngramServer(
  socketPath: string,
  handler: (msg: any) => void,
): net.Server {
  // Remove stale socket file if it exists
  try {
    fs.unlinkSync(socketPath);
  } catch {}

  // Ensure parent directory exists
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true });

  const server = net.createServer((conn) => {
    let data = '';
    let dataBytes = 0;

    // A-I1: Timeout -- if no data arrives within 10s, destroy the connection
    const idleTimer = setTimeout(() => {
      console.error('[uds] connection timeout, destroying');
      conn.destroy();
    }, CONNECTION_TIMEOUT);

    conn.on('data', (chunk) => {
      dataBytes += chunk.length;
      // A-I1: Data limit -- prevent memory exhaustion from rogue connections
      if (dataBytes > MAX_DATA_BYTES) {
        console.error('[uds] connection exceeded 64KB data limit, destroying');
        clearTimeout(idleTimer);
        conn.destroy();
        return;
      }
      data += chunk.toString();
    });
    conn.on('end', () => {
      clearTimeout(idleTimer);
      // N1: Separate parse and handler try/catch for distinct error diagnostics
      let msg: any;
      try {
        msg = JSON.parse(data.trim());
      } catch (err) {
        console.error('[uds] failed to parse message:', (err as Error).message);
        return;
      }
      // W4: Basic schema validation — must be an object with an 'event' string
      if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') {
        console.error('[uds] invalid message schema — missing event field');
        return;
      }
      // W2: Await async handlers — prevents unhandled rejections from async handler functions
      Promise.resolve(handler(msg)).catch((err: Error) => {
        console.error('[uds] handler error:', err.message);
      });
    });
    conn.on('error', (err) => {
      clearTimeout(idleTimer);
      console.error('[uds] connection error:', err.message);
    });
  });

  server.on('error', (err) => {
    console.error('[uds] server error:', err.message);
  });

  server.listen(socketPath, () => {
    // W4: Restrict socket permissions to owner only (prevents other users from sending commands)
    try { fs.chmodSync(socketPath, 0o600); } catch {}
    console.error(`[uds] listening on ${socketPath}`);
  });

  return server;
}

/**
 * UDS Client -- used by hooks (e.g. stop hook).
 * Connects to socketPath, writes a JSON message, disconnects.
 * Returns true on success, false if daemon is not running (ECONNREFUSED).
 */
export async function sendEngramMessage(
  socketPath: string,
  msg: object,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (val: boolean) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(val);
      }
    };

    const client = net.createConnection({ path: socketPath }, () => {
      client.end(JSON.stringify(msg) + '\n');
    });

    const timeout = setTimeout(() => {
      client.destroy();
      settle(false);
    }, CONNECT_TIMEOUT);

    client.on('end', () => {
      settle(true);
    });

    client.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ENOENT') {
        console.error('[uds] client error:', err.message);
      }
      settle(false);
    });

    // A-I2: Fallback for daemon crashes that only fire 'close' (no 'end' or 'error')
    client.on('close', () => {
      settle(false);
    });
  });
}

export { SOCKET_PATH };
