#!/usr/bin/env bun
/**
 * PreCompact hook — fired when Claude Code context is nearing its limit.
 *
 * Saves the current session's most important context to disk so it
 * survives compaction.
 *
 * Behaviour:
 *   1. Read hook payload from stdin (JSON)
 *   2. If total_tokens <= 150 000 → exit 0 (no-op)
 *   3. If session already flushed (flush-state.json) → exit 0
 *   4. Extract urgent context via OpenAI gpt-4o-mini (or plain excerpt if no key)
 *   5. Append to <project>/.claude/memory/YYYY-MM-DD.md
 *   6. Record session_id in flush-state.json
 *   7. Re-index the daily log file
 */

import fs from 'fs';
import path from 'path';
import os from 'node:os';
import OpenAI from 'openai';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { indexFile } from '../mcp/indexer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_THRESHOLD = 150_000;
const FLUSH_STATE_PATH = path.join(os.homedir(), '.claude-memory', 'flush-state.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Resolve the daily log directory.
 * Walk up from cwd looking for a .claude/ directory.
 * Fallback: ~/.claude-memory/memory/
 */
function resolveMemoryDir(cwd: string): string {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, '.claude', 'memory');
    if (fs.existsSync(path.join(dir, '.claude'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }
  // Fallback to global
  return path.join(os.homedir(), '.claude-memory', 'memory');
}

/**
 * Read, merge, and write back flush-state.json.
 */
function readFlushState(): Record<string, boolean> {
  try {
    return JSON.parse(fs.readFileSync(FLUSH_STATE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeFlushState(state: Record<string, boolean>): void {
  fs.mkdirSync(path.dirname(FLUSH_STATE_PATH), { recursive: true });
  fs.writeFileSync(FLUSH_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Extract the most recent messages from the transcript for summarisation.
 * Limits to roughly the last 6000 characters to keep the OpenAI call small.
 */
function extractRecentTranscript(messages: unknown[]): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const MAX_CHARS = 6000;
  const parts: string[] = [];
  let total = 0;

  // Walk backwards through messages
  for (let i = messages.length - 1; i >= 0 && total < MAX_CHARS; i--) {
    const msg = messages[i] as Record<string, unknown>;
    const role = (msg.role ?? 'unknown') as string;
    let content = '';
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .map((c: Record<string, unknown>) => (typeof c.text === 'string' ? c.text : ''))
        .join('\n');
    }
    if (!content) continue;

    const line = `[${role}]: ${content}`;
    parts.unshift(line);
    total += line.length;
  }

  return parts.join('\n\n').slice(0, MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Read hook payload from stdin
  let raw: string;
  try {
    raw = fs.readFileSync('/dev/stdin', 'utf-8');
  } catch {
    process.exit(0); // stdin unavailable (CI, Windows, etc.) → no-op
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unparseable → no-op
  }

  const sessionId = (payload.session_id ?? payload.sessionId ?? '') as string;
  const cwd = (payload.cwd ?? process.cwd()) as string;
  const totalTokens = Number(payload.total_tokens ?? payload.context_length ?? 0);
  const messages = (payload.transcript ?? payload.messages ?? []) as unknown[];

  // 2. Check threshold
  if (totalTokens <= TOKEN_THRESHOLD) {
    process.exit(0);
  }

  // 3. Check flush state — prevent double-firing
  const flushState = readFlushState();
  if (sessionId && flushState[sessionId]) {
    process.exit(0);
  }

  // 4. Extract urgent context
  const transcript = extractRecentTranscript(messages);
  if (!transcript) {
    // Record flush even on empty transcript — prevents repeated re-firing on
    // subsequent compaction events for the same session.
    if (sessionId) {
      flushState[sessionId] = true;
      writeFlushState(flushState);
    }
    process.exit(0);
  }

  let contextNotes: string;
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    // Use gpt-4o-mini to extract critical context
    try {
      const openai = new OpenAI({ apiKey });
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content:
              'You are a context-preservation assistant. Extract the most critical context from this session that would be lost after compaction. Focus on: current task state, key decisions made, open problems, important file paths. Output concise bullet points in Markdown.',
          },
          {
            role: 'user',
            content: transcript,
          },
        ],
      });
      contextNotes = resp.choices[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      console.error('[pre-compact] OpenAI call failed, falling back to plain excerpt:', (err as Error).message);
      contextNotes = '';
    }
  } else {
    contextNotes = '';
  }

  // Fallback: plain excerpt if no AI summary available
  if (!contextNotes) {
    contextNotes = transcript.slice(0, 1500);
  }

  // 5. Write to daily log
  const memoryDir = resolveMemoryDir(cwd);
  fs.mkdirSync(memoryDir, { recursive: true });

  const dailyLogPath = path.join(memoryDir, `${today()}.md`);
  const entry = [
    '',
    `## ${nowTime()} Pre-Compact Flush`,
    '',
    contextNotes,
    '',
  ].join('\n');

  fs.appendFileSync(dailyLogPath, entry);

  // 6. Update flush state
  if (sessionId) {
    flushState[sessionId] = true;
    writeFlushState(flushState);
  }

  // 7. Re-index the daily log file
  try {
    const db = initDb(DB_PATH);
    const isGlobal = memoryDir.startsWith(path.join(os.homedir(), '.claude-memory'));
    indexFile(db, dailyLogPath, isGlobal ? 'global' : 'project', isGlobal ? undefined : cwd);
    db.close();
  } catch (err) {
    console.error('[pre-compact] re-index failed:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[pre-compact] fatal:', err);
  process.exit(1);
});
