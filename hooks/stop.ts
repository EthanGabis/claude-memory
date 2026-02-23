import fs from 'fs';
import path from 'path';
import os from 'node:os';
import OpenAI from 'openai';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { indexFile } from '../mcp/indexer.js';

// ---------------------------------------------------------------------------
// Stop-nudge constants
// ---------------------------------------------------------------------------

const STOP_NUDGE_STATE_PATH = path.join(os.homedir(), '.claude-memory', 'stop-nudge-state.json');
const GLOBAL_MEMORY_PATH = path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
const SUBSTANTIVE_THRESHOLD = 1000; // chars
const MEMORY_RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const NUDGE_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Stop-nudge helpers
// ---------------------------------------------------------------------------

interface NudgeState {
  sessions: Record<string, { nudged_at: number }>;
}

function readNudgeState(): NudgeState {
  try {
    const raw = fs.readFileSync(STOP_NUDGE_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as NudgeState;
    // Clean up entries older than 24 hours
    const now = Date.now();
    const cleaned: NudgeState = { sessions: {} };
    for (const [sid, entry] of Object.entries(parsed.sessions ?? {})) {
      if (now - (entry.nudged_at ?? 0) < NUDGE_STALE_MS) {
        cleaned.sessions[sid] = entry;
      }
    }
    return cleaned;
  } catch {
    return { sessions: {} };
  }
}

function writeNudgeState(state: NudgeState): void {
  try {
    fs.mkdirSync(path.dirname(STOP_NUDGE_STATE_PATH), { recursive: true });
    fs.writeFileSync(STOP_NUDGE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // fail silently
  }
}

function wasMemoryRecentlyWritten(): boolean {
  try {
    const stat = fs.statSync(GLOBAL_MEMORY_PATH);
    return Date.now() - stat.mtimeMs < MEMORY_RECENT_WINDOW_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookPayload {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  transcript?: Array<{ role: string; content: string }> | string;
}

interface SessionSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `dir` looking for a `.claude/` directory.
 * Returns the path to the `.claude/memory/` directory, or null if none found.
 */
function findClaudeMemoryDir(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    const candidate = path.join(current, '.claude', 'memory');
    if (fs.existsSync(path.join(current, '.claude'))) {
      return candidate;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Determine the output directory for the daily log.
 * Priority: cwd's .claude/memory/ -> walk up parents -> global fallback.
 */
function getMemoryDir(cwd: string): string {
  const found = findClaudeMemoryDir(cwd);
  if (found) return found;
  return path.join(os.homedir(), '.claude-memory', 'memory');
}

/**
 * Format the current local time as HH:MM.
 */
function formatTime(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Format today's date as YYYY-MM-DD.
 */
function formatDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Extract a flat text representation of the transcript for summarisation.
 */
function flattenTranscript(
  transcript: Array<{ role: string; content: string }> | string | undefined,
): string {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript;
  if (!Array.isArray(transcript) || transcript.length === 0) return '';

  return transcript
    .map((msg) => `${msg.role}: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`)
    .join('\n');
}

/**
 * Summarise a session transcript using OpenAI gpt-4o-mini.
 * Returns null if the API key is missing or the call fails.
 */
async function summariseWithAI(transcriptText: string): Promise<SessionSummary | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const openai = new OpenAI({ apiKey });

  try {
    const response = await Promise.race([
      openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `You summarise Claude Code session transcripts into structured notes.
Respond with ONLY a JSON object (no markdown fences) with these four string fields:
- request: what the user asked for (1-2 sentences)
- investigated: what was explored or read (1-2 sentences)
- learned: key discoveries or decisions (1-2 sentences)
- completed: what was accomplished (1-2 sentences)
Keep each field concise. If a field has no relevant info, use "N/A".`,
          },
          {
            role: 'user',
            content: transcriptText.slice(0, 30_000), // cap input to avoid token limits
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI summarization timed out after 30s')), 30_000),
      ),
    ]);

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text);
    return {
      request: parsed.request ?? 'N/A',
      investigated: parsed.investigated ?? 'N/A',
      learned: parsed.learned ?? 'N/A',
      completed: parsed.completed ?? 'N/A',
    };
  } catch (err) {
    console.error('[stop-hook] AI summarisation failed:', (err as Error).message);
    return null;
  }
}

/**
 * Build a fallback summary from raw transcript when AI is unavailable.
 */
function buildFallbackSummary(transcriptText: string): SessionSummary {
  const excerpt = transcriptText.slice(0, 500).replace(/\n/g, ' ').trim();
  return {
    request: excerpt || 'No transcript available',
    investigated: 'N/A',
    learned: 'N/A',
    completed: 'N/A',
  };
}

/**
 * Format a session summary as a Markdown block.
 */
function formatEntry(summary: SessionSummary): string {
  const time = formatTime();
  return [
    `## ${time} Session`,
    `**Request:** ${summary.request}`,
    `**Investigated:** ${summary.investigated}`,
    `**Learned:** ${summary.learned}`,
    `**Completed:** ${summary.completed}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read hook payload from stdin
  let rawInput = '';
  try {
    rawInput = fs.readFileSync('/dev/stdin', 'utf-8');
  } catch {
    // If stdin is empty or unreadable, exit gracefully
    process.exit(0);
  }

  if (!rawInput.trim()) {
    process.exit(0);
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    console.error('[stop-hook] Failed to parse stdin as JSON');
    process.exit(0);
  }

  const cwd = payload.cwd ?? process.cwd();
  const sessionId = (payload.session_id ?? payload.sessionId ?? '') as string;

  // 2. Flatten transcript
  const transcriptText = flattenTranscript(payload.transcript);

  // 2b. One-time memory nudge — block stop if session was substantive and no MEMORY.md writes
  try {
    if (transcriptText.length > SUBSTANTIVE_THRESHOLD && sessionId) {
      const nudgeState = readNudgeState();

      if (!nudgeState.sessions[sessionId]) {
        // First stop attempt for this session — check if MEMORY.md was recently written
        if (!wasMemoryRecentlyWritten()) {
          // Record that we nudged this session
          nudgeState.sessions[sessionId] = { nudged_at: Date.now() };
          writeNudgeState(nudgeState);

          // Block the stop and ask the agent to save memories
          process.stdout.write(
            JSON.stringify({
              decision: 'block',
              reason:
                "Before ending: you had a substantive session. Save any durable facts (preferences, decisions, debugging insights) to memory via memory_save(target='memory'). If nothing to save, say 'nothing to save' and I'll let you end.",
            }) + '\n',
          );
          process.exit(0);
        }
      }
      // If already nudged, fall through to normal stop behavior
    }
  } catch {
    // Nudge logic failed — fall through to normal stop behavior
  }

  // 3. Summarise (AI or fallback)
  let summary: SessionSummary;
  if (transcriptText) {
    const aiSummary = await summariseWithAI(transcriptText);
    summary = aiSummary ?? buildFallbackSummary(transcriptText);
  } else {
    summary = {
      request: 'Empty session',
      investigated: 'N/A',
      learned: 'N/A',
      completed: 'N/A',
    };
  }

  // 4. Write to daily log
  const memoryDir = getMemoryDir(cwd);
  const dailyLogPath = path.join(memoryDir, `${formatDate()}.md`);

  fs.mkdirSync(memoryDir, { recursive: true });

  const entry = formatEntry(summary);
  fs.appendFileSync(dailyLogPath, entry + '\n');

  // 5. Background re-index
  const db = initDb(DB_PATH);
  try {
    const projectName = findClaudeMemoryDir(cwd) ? path.basename(cwd) : undefined;
    const layer = projectName ? 'project' : 'global';
    await indexFile(db, dailyLogPath, layer, projectName);
  } catch (err) {
    console.error('[stop-hook] Re-indexing failed:', (err as Error).message);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[stop-hook] Unexpected error:', err);
  process.exit(1);
});
