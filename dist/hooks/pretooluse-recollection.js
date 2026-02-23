#!/usr/bin/env bun
/**
 * PreToolUse recollection hook — fires before every tool call.
 *
 * Reads pre-computed "memory bites" from the Engram Processor and injects
 * them as additionalContext so Claude sees relevant memories during work.
 *
 * Behaviour:
 *   1. Resolve session ID (stdin JSON → env var)
 *   2. Read ~/.claude-memory/recollections/<sessionId>.json
 *   3. Dedup by messageUuid (skip if already injected for this user message)
 *   4. Output JSON with formatted memory bites as additionalContext
 *
 * Performance target: <5ms — only file reads/writes, no DB, no embedding, no API.
 */
import fs from 'fs';
import path from 'path';
import os from 'node:os';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RECOLLECTIONS_DIR = path.join(os.homedir(), '.claude-memory', 'recollections');
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Drain stdin to avoid pipe issues (hook convention)
let stdinRaw = '';
try {
    stdinRaw = fs.readFileSync('/dev/stdin', 'utf-8');
}
catch { }
try {
    // -------------------------------------------------------------------------
    // 1. Resolve session ID (stdin JSON → env var)
    // -------------------------------------------------------------------------
    let sessionId = null;
    // Strategy A: Parse stdin JSON for session_id
    if (stdinRaw) {
        try {
            const input = JSON.parse(stdinRaw);
            sessionId = input?.session_id ?? input?.sessionId ?? null;
        }
        catch { }
    }
    // Strategy B: Environment variable
    if (!sessionId) {
        sessionId = process.env.CLAUDE_SESSION_ID?.trim() || null;
    }
    // No session ID found — exit silently
    if (!sessionId)
        process.exit(0);
    // Validate sessionId to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        process.exit(0); // Invalid sessionId, bail out safely
    }
    // -------------------------------------------------------------------------
    // 2. Read recollection file
    // -------------------------------------------------------------------------
    const recollectionPath = path.join(RECOLLECTIONS_DIR, `${sessionId}.json`);
    let raw;
    try {
        raw = fs.readFileSync(recollectionPath, 'utf-8');
    }
    catch {
        // Missing or unreadable — exit silently
        process.exit(0);
    }
    if (!raw.trim())
        process.exit(0);
    const recollection = JSON.parse(raw);
    if (!recollection?.bites?.length)
        process.exit(0);
    // -------------------------------------------------------------------------
    // 3. Dedup by messageUuid (skip if no uuid — inject unconditionally)
    // -------------------------------------------------------------------------
    const statePath = path.join(RECOLLECTIONS_DIR, `${sessionId}.state`);
    const uuid = recollection.messageUuid;
    if (uuid) {
        try {
            const stateRaw = fs.readFileSync(statePath, 'utf-8');
            const state = JSON.parse(stateRaw);
            if (state.lastInjectedMessageUuid === uuid) {
                // Already injected for this user message — skip
                process.exit(0);
            }
        }
        catch {
            // No state file or corrupted — proceed (first injection)
        }
        // -----------------------------------------------------------------------
        // 4. Update state
        // -----------------------------------------------------------------------
        fs.writeFileSync(statePath, JSON.stringify({ lastInjectedMessageUuid: uuid }));
    }
    // If no uuid, skip dedup and inject unconditionally
    // -------------------------------------------------------------------------
    // 5. Format bites and output
    // -------------------------------------------------------------------------
    const bitesText = recollection.bites
        .map((b) => `${b.bite} (expand: memory_expand("${b.id}"))`)
        .join('\n');
    const additionalContext = 'You have memories related to this conversation:\n' +
        bitesText + '\n' +
        'If any of these are relevant, you can call memory_expand(id) to recall the full context. Otherwise, continue your work.';
    const output = {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext,
            permissionDecision: "allow",
        },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
}
catch {
    // Any error — silent pass-through (never block Claude)
}
