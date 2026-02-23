#!/usr/bin/env bun
/**
 * SessionStart hook — fired when a new Claude Code session begins.
 *
 * Injects memory context into the session via hook stdout JSON.
 *
 * Behaviour:
 *   1. Read hook payload from stdin (JSON). Fields: session_id, cwd.
 *   2. Detect current project: walk up from cwd looking for .claude/ directory.
 *      If found: use that as project root. Fallback: global only.
 *   3. Read ~/.claude-memory/MEMORY.md (global, max 4000 tokens).
 *   4. Read <project>/.claude/memory/MEMORY.md (project, max 4000 tokens).
 *   5. Read last 3 project daily logs (YYYY-MM-DD.md), newest-first, max 2000 tokens each.
 *   6. Build context string combining all layers.
 *   7. Hard cap: 8000 tokens total. Truncate oldest log first, then project MEMORY.md,
 *      then global MEMORY.md.
 *   8. Output JSON to stdout: { "context": "<assembled context string>" }
 *   9. Never write to CLAUDE.md on disk. Never modify any files.
 */

import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { get_encoding } from 'tiktoken';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GLOBAL_MEMORY_PATH = path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
const COMPACT_PENDING_PATH = path.join(os.homedir(), '.claude-memory', 'compact-pending.json');
const COMPACT_FLAG_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_GLOBAL_TOKENS = 4000;
const MAX_PROJECT_TOKENS = 4000;
const MAX_LOG_TOKENS = 2000;
const MAX_TOTAL_TOKENS = 8000;
const MAX_DAILY_LOGS = 3;

// ---------------------------------------------------------------------------
// Token counting (singleton encoder — expensive to create)
// ---------------------------------------------------------------------------

let _enc: ReturnType<typeof get_encoding> | null = null;

function getEncoder(): ReturnType<typeof get_encoding> {
  if (!_enc) {
    _enc = get_encoding('cl100k_base');
  }
  return _enc;
}

function countTokens(text: string): number {
  const enc = getEncoder();
  return enc.encode(text).length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `dir` looking for a `.claude/` directory.
 * Returns the path to the `.claude/memory/` directory under the project root,
 * or null if none found.
 */
function findProjectMemoryDir(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    const claudeDir = path.join(current, '.claude');
    try {
      const stat = fs.statSync(claudeDir);
      if (stat.isDirectory()) {
        return path.join(claudeDir, 'memory');
      }
    } catch {
      // not found, continue walking up
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Safely read a file, returning null if it doesn't exist or can't be read.
 */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Truncate text to a maximum number of tokens.
 * Decodes back to string after token slicing to avoid cutting mid-character.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;
  const sliced = tokens.slice(0, maxTokens);
  return new TextDecoder().decode(enc.decode(sliced));
}

/**
 * Get the last N daily log files from a memory directory, sorted newest-first.
 * Only files matching YYYY-MM-DD.md are included.
 */
function getRecentDailyLogs(memoryDir: string, maxLogs: number): string[] {
  try {
    return fs
      .readdirSync(memoryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, maxLogs)
      .map((f) => path.join(memoryDir, f));
  } catch {
    return [];
  }
}

/**
 * Extract the date string (YYYY-MM-DD) from a daily log file path basename.
 */
function dateFromLogPath(logPath: string): string {
  return path.basename(logPath, '.md');
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

interface ContextParts {
  globalMemory: string | null;
  projectMemory: string | null;
  dailyLogs: Array<{ date: string; content: string }>;
}

/**
 * Assemble the final context string from parts.
 * Only includes sections that have content.
 */
function assembleContext(parts: ContextParts): string {
  const sections: string[] = ['# Memory Context'];

  if (parts.globalMemory) {
    sections.push('\n## Global Memory\n');
    sections.push(parts.globalMemory);
  }

  if (parts.projectMemory) {
    sections.push('\n## Project Memory\n');
    sections.push(parts.projectMemory);
  }

  if (parts.dailyLogs.length > 0) {
    sections.push('\n## Recent Activity');
    for (const log of parts.dailyLogs) {
      sections.push(`\n### ${log.date}\n`);
      sections.push(log.content);
    }
  }

  // If only the header was added, return empty string to avoid injecting noise
  if (sections.length === 1) return '';

  return sections.join('\n');
}

/**
 * Apply the hard 8000-token cap by truncating in order:
 *   1. Remove oldest daily log entries first
 *   2. Truncate project MEMORY.md
 *   3. Truncate global MEMORY.md
 */
function applyHardCap(parts: ContextParts): ContextParts {
  // Build a working copy
  const result: ContextParts = {
    globalMemory: parts.globalMemory,
    projectMemory: parts.projectMemory,
    dailyLogs: [...parts.dailyLogs],
  };

  function totalTokens(): number {
    return countTokens(assembleContext(result));
  }

  // Step 1: Remove oldest logs (they're stored newest-first, so pop from the end)
  while (totalTokens() > MAX_TOTAL_TOKENS && result.dailyLogs.length > 0) {
    result.dailyLogs.pop();
  }

  // Step 2: Truncate project MEMORY.md
  if (totalTokens() > MAX_TOTAL_TOKENS && result.projectMemory) {
    const over = totalTokens() - MAX_TOTAL_TOKENS;
    const currentTokens = countTokens(result.projectMemory);
    const targetTokens = Math.max(0, currentTokens - over);
    result.projectMemory = targetTokens > 0 ? truncateToTokens(result.projectMemory, targetTokens) : null;
  }

  // Step 3: Truncate global MEMORY.md
  if (totalTokens() > MAX_TOTAL_TOKENS && result.globalMemory) {
    const over = totalTokens() - MAX_TOTAL_TOKENS;
    const currentTokens = countTokens(result.globalMemory);
    const targetTokens = Math.max(0, currentTokens - over);
    result.globalMemory = targetTokens > 0 ? truncateToTokens(result.globalMemory, targetTokens) : null;
  }

  // Final safety: re-check assembled total accounts for markup overhead
  let safetyRound = 0;
  while (totalTokens() > MAX_TOTAL_TOKENS && safetyRound < 10) {
    safetyRound++;
    const over = totalTokens() - MAX_TOTAL_TOKENS;

    if (result.projectMemory) {
      const cur = countTokens(result.projectMemory);
      const target = Math.max(0, cur - over);
      result.projectMemory = target > 0
        ? truncateToTokens(result.projectMemory, target)
        : null;
    } else if (result.globalMemory) {
      const cur = countTokens(result.globalMemory);
      const target = Math.max(0, cur - over);
      result.globalMemory = target > 0
        ? truncateToTokens(result.globalMemory, target)
        : null;
    } else {
      break; // nothing left to trim
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // 1. Read hook payload from stdin
  let raw: string;
  try {
    raw = fs.readFileSync('/dev/stdin', 'utf-8');
  } catch {
    // stdin unavailable (CI, Windows, etc.) → output empty context and exit
    process.stdout.write(JSON.stringify({ context: '' }) + '\n');
    process.exit(0);
  }

  if (!raw.trim()) {
    process.stdout.write(JSON.stringify({ context: '' }) + '\n');
    process.exit(0);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Unparseable input → safe exit with empty context
    process.stdout.write(JSON.stringify({ context: '' }) + '\n');
    process.exit(0);
  }

  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  // 2. Detect current project
  const projectMemoryDir = findProjectMemoryDir(cwd);

  // 3. Read global MEMORY.md (max 4000 tokens)
  let globalMemory: string | null = null;
  const rawGlobal = safeReadFile(GLOBAL_MEMORY_PATH);
  if (rawGlobal && rawGlobal.trim()) {
    globalMemory = truncateToTokens(rawGlobal, MAX_GLOBAL_TOKENS);
  }

  // 4. Read project MEMORY.md (max 4000 tokens)
  let projectMemory: string | null = null;
  if (projectMemoryDir) {
    const projectMemoryPath = path.join(projectMemoryDir, 'MEMORY.md');
    const rawProject = safeReadFile(projectMemoryPath);
    if (rawProject && rawProject.trim()) {
      projectMemory = truncateToTokens(rawProject, MAX_PROJECT_TOKENS);
    }
  }

  // 5. Read last 3 daily logs (max 2000 tokens each)
  const dailyLogs: Array<{ date: string; content: string }> = [];
  if (projectMemoryDir) {
    const logPaths = getRecentDailyLogs(projectMemoryDir, MAX_DAILY_LOGS);
    for (const logPath of logPaths) {
      const rawLog = safeReadFile(logPath);
      if (rawLog && rawLog.trim()) {
        const truncated = truncateToTokens(rawLog, MAX_LOG_TOKENS);
        dailyLogs.push({
          date: dateFromLogPath(logPath),
          content: truncated,
        });
      }
    }
  }

  // 6. Build initial context parts
  let parts: ContextParts = {
    globalMemory,
    projectMemory,
    dailyLogs,
  };

  // 7. Apply hard 8000-token cap
  parts = applyHardCap(parts);

  // 8. Assemble context
  let context = assembleContext(parts);

  // 9. Check for post-compaction flag and inject recovery nudge
  const sessionId = typeof payload.session_id === 'string'
    ? payload.session_id
    : typeof payload.sessionId === 'string'
      ? payload.sessionId
      : '';

  try {
    if (fs.existsSync(COMPACT_PENDING_PATH)) {
      const flagRaw = fs.readFileSync(COMPACT_PENDING_PATH, 'utf-8');
      const flag = JSON.parse(flagRaw) as { timestamp?: number; session_id?: string };
      const age = Date.now() - (flag.timestamp ?? 0);

      // Only consume the flag if it belongs to this session (or has no session_id)
      if (flag.session_id && flag.session_id !== sessionId) {
        // Not our flag — leave it for the correct session
      } else {
        if (age < COMPACT_FLAG_MAX_AGE_MS) {
          // Fresh flag — inject compaction recovery message
          context +=
            '\n\n**IMPORTANT: This session was just compacted. If you had unsaved durable knowledge (user preferences, architecture decisions, debugging insights), save them now via memory_save(target=\'memory\'). If nothing to save, continue normally.**';
        }

        // Clean up the flag (it's ours or has no session_id)
        try {
          fs.unlinkSync(COMPACT_PENDING_PATH);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  } catch {
    // fail silently — compaction detection is best-effort
  }

  // 10. Output JSON to stdout
  process.stdout.write(JSON.stringify({ context }) + '\n');

  process.exit(0);
}

main();
