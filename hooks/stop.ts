import fs from 'fs';
import path from 'path';
import os from 'node:os';
import OpenAI from 'openai';
import { initDb, DB_PATH } from '../mcp/schema.js';
import { indexFile } from '../mcp/indexer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookPayload {
  session_id?: string;
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
    const response = await openai.chat.completions.create({
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
    });

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

  // 2. Flatten transcript
  const transcriptText = flattenTranscript(payload.transcript);

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
  try {
    const db = initDb(DB_PATH);
    const project = findClaudeMemoryDir(cwd) ? cwd : undefined;
    const layer = project ? 'project' : 'global';
    await indexFile(db, dailyLogPath, layer, project);
    db.close();
  } catch (err) {
    console.error('[stop-hook] Re-indexing failed:', (err as Error).message);
  }
}

main().catch((err) => {
  console.error('[stop-hook] Unexpected error:', err);
  process.exit(1);
});
