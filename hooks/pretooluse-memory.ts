#!/usr/bin/env bun
/**
 * PreToolUse memory nudge hook — fires before every tool call.
 *
 * Part of the pre-compaction memory flush chain:
 *   StatusLine (detect) → **PreToolUse (nudge)** → PreCompact (backup) → SessionStart (recovery)
 *
 * Behaviour:
 *   1. Read flush-marker.json from ~/.claude-memory/
 *   2. If missing or unreadable → exit silently (no output)
 *   3. If marker is stale (>30 minutes old) → delete it, exit silently
 *   4. If marker.flushed === true → exit silently (already nudged)
 *   5. If marker.flushed === false → set flushed=true, write marker back,
 *      output JSON with additionalContext nudge and permissionDecision:"allow"
 */

import fs from 'fs';
import path from 'path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKER_PATH = path.join(os.homedir(), '.claude-memory', 'flush-marker.json');
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Drain stdin to avoid pipe issues (hook convention)
try { fs.readFileSync('/dev/stdin', 'utf-8'); } catch {}

try {
  const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
  const marker = JSON.parse(raw);

  // Staleness check — ignore markers from crashed/stale sessions or invalid timestamps
  const ts = new Date(marker.timestamp).getTime();
  if (!Number.isFinite(ts) || (Date.now() - ts) > STALE_THRESHOLD_MS) {
    fs.unlinkSync(MARKER_PATH);
    process.exit(0);
  }

  if (!marker.flushed) {
    // Mark as flushed to prevent repeated nudges
    marker.flushed = true;
    fs.writeFileSync(MARKER_PATH, JSON.stringify(marker));

    // Inject the memory flush prompt via additionalContext
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "STOP — Context is nearing compaction threshold. " +
          "Before your next action, save any durable knowledge " +
          "(user preferences, architecture decisions, debugging insights, project facts) " +
          "via memory_save(target='memory'). " +
          "Save today's session context via memory_save(target='log'). " +
          "Then continue your work.",
        permissionDecision: "allow",
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  // If already flushed: no output (silent pass-through)
} catch {
  // No marker, corrupted JSON, or fs error — silent pass-through
}
