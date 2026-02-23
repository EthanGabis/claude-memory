# Implementation Plan: Pre-Compaction Memory Flush (OpenClaw Exact Match)

**Date:** 2026-02-23
**Status:** Awaiting approval
**Research:** Phase 3 findings from compaction-researcher agent
**Reviewed:** Plan reviewer scored 4/10; all 3 CRITICAL and 5 IMPORTANT issues addressed below.

---

## Feature Summary

**Idea:** Implement a 4-hook chain that prompts the agent to save memories BEFORE compaction — matching OpenClaw's pre-compaction memory flush behavior.
**Problem:** Current approach nudges AFTER compaction (via SessionStart), meaning the agent has already lost the context it should be saving. OpenClaw nudges BEFORE, while full context is available.
**Chosen approach:** 4-hook chain — StatusLine (detect) → PreToolUse (nudge) → PreCompact (backup) → SessionStart (recovery)

---

## Architecture

### How OpenClaw Does It
OpenClaw owns the agent runner and intercepts the conversation loop. When `totalTokens >= contextWindow - 20000 - 4000`, it injects a separate agent turn with: "Session nearing compaction. Store durable memories now." The agent writes memories, then the main turn continues.

### How We Match It (within Claude Code's constraints)
Claude Code hooks are external shell commands — they can't pause the agent for a turn. But we can:
1. **Detect** approaching compaction via StatusLine (the ONLY hook with live token metrics)
2. **Nudge** the agent via PreToolUse additionalContext (fires before every tool call)
3. **Backup** critical context via PreCompact (existing safety net)
4. **Recover** via SessionStart post-compaction (existing recovery)

### The 4-Hook Chain

```
┌─ StatusLine Hook (every turn) ─────────────────────────────┐
│ Integrated into: statusline-combined.sh (NOT a new file)   │
│ Computes used_pct from raw token counts:                   │
│   input_tokens + cache_creation + cache_read / ctx_size    │
│ When used_pct > 65 (i.e., <35% remaining):                │
│   → Write marker: ~/.claude-memory/flush-marker.json       │
│   → Contains: { timestamp, used_pct, flushed: false }      │
└────────────────────────────────────────────────────────────┘
          ↓
┌─ PreToolUse Hook (every tool call) ───────────────────────┐
│ Bash guard: `test -f` before spawning bun (zero-cost      │
│ when marker absent — no bun startup on 95%+ of calls)     │
│ If marker exists AND flushed === false AND <30min old:     │
│   → Set flushed = true (prevent repeated nudges)          │
│   → Output JSON with additionalContext nudge              │
│ If no marker, already flushed, or stale:                  │
│   → No output (silent pass-through)                       │
└───────────────────────────────────────────────────────────┘
          ↓ (agent sees the nudge, saves memories)
┌─ PreCompact Hook (when compaction triggers) ──────────────┐
│ Existing behavior: gpt-4o-mini extraction → daily log     │
│ Added: clean up flush-marker.json (reset for next cycle)  │
│ Existing: compact-pending.json flag for SessionStart      │
└───────────────────────────────────────────────────────────┘
          ↓ (compaction occurs)
┌─ SessionStart Hook (post-compaction) ─────────────────────┐
│ Existing behavior: loads MEMORY.md + daily logs           │
│ Existing: detect compact-pending.json → recovery nudge    │
└───────────────────────────────────────────────────────────┘
```

---

## Implementation Tasks

### Task 1: Add flush-marker logic to statusline-combined.sh
**File:** `~/.claude/statusline-combined.sh` (MODIFY — append 6 lines)

The `statusLine` setting in settings.json is a **singleton object at root level** (NOT under `hooks`). Only ONE statusLine command is allowed. We CANNOT register a second hook — we must integrate into the existing script.

The existing `statusline-powerline-custom.sh` already computes `context_pct` from raw token counts (`input_tokens + cache_creation + cache_read`). We replicate this computation in the combined script.

Add after line 6 (`input=$(cat)`), before line1/line2:
```bash
# --- Pre-compaction flush marker ---
MARKER="$HOME/.claude-memory/flush-marker.json"
if [ ! -f "$MARKER" ]; then
  used_pct=$(echo "$input" | jq '
    (.context_window.current_usage.input_tokens // 0) +
    (.context_window.current_usage.cache_creation_input_tokens // 0) +
    (.context_window.current_usage.cache_read_input_tokens // 0)
  ' 2>/dev/null)
  ctx_size=$(echo "$input" | jq '.context_window.context_window_size // 0' 2>/dev/null)
  if [ "${ctx_size:-0}" -gt 0 ] && [ "${used_pct:-0}" -gt 0 ]; then
    pct=$(( used_pct * 100 / ctx_size ))
    if [ "$pct" -gt 65 ]; then
      mkdir -p "$HOME/.claude-memory"
      printf '{"timestamp":"%s","used_pct":%d,"flushed":false}' "$(date -u +%FT%TZ)" "$pct" > "$MARKER"
    fi
  fi
fi
```

**Why 65% used (= 35% remaining):** On a 200K context window, 35% = ~70K tokens remaining. Auto-compact triggers at roughly ~16.5% remaining (~33K tokens). This gives the agent ~37K tokens of headroom to save memories — similar to OpenClaw's `softThresholdTokens: 4000` + `reserveTokensFloor: 20000` = ~24K buffer.

**Performance:** Zero overhead — just jq parsing (already done) + one `test -f` + conditional write. No bun, no TypeScript.

### Task 2: Create PreToolUse memory nudge hook
**File:** `hooks/pretooluse-memory.ts` (NEW)
**Register in:** `~/.claude/settings.json` under `PreToolUse` event

Fires before every tool call. The settings.json command uses a **bash guard** to avoid bun startup when no marker exists:

```bash
test -f ~/.claude-memory/flush-marker.json && bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pretooluse-memory.ts || true
```

This means bun only starts when the marker file exists (~5% of tool calls in a compacting session, 0% in normal sessions). Cost when no marker: ~2ms (`test -f` only).

Logic (TypeScript):
```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

const MARKER_PATH = path.join(os.homedir(), '.claude-memory', 'flush-marker.json');
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

try {
  const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
  const marker = JSON.parse(raw);

  // Staleness check — ignore markers from crashed/stale sessions
  const age = Date.now() - new Date(marker.timestamp).getTime();
  if (age > STALE_THRESHOLD_MS) {
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
        additionalContext: "STOP — Context is nearing compaction threshold. " +
          "Before your next action, save any durable knowledge " +
          "(user preferences, architecture decisions, debugging insights, project facts) " +
          "via memory_save(target='memory'). " +
          "Save today's session context via memory_save(target='log'). " +
          "Then continue your work.",
        permissionDecision: "allow"
      }
    };
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  // If already flushed: no output (silent pass-through)
} catch {
  // No marker, corrupted JSON, or fs error — silent pass-through
}
```

**Key design decisions:**
- **Staleness check (30min):** Prevents stale markers from crashed sessions causing spurious nudges in new sessions.
- **Stronger nudge text:** "STOP —" prefix is more directive than "IMPORTANT:" to increase agent compliance under cognitive load near compaction.
- **No output when no action needed:** Empty stdout = no interference with other PreToolUse hooks.
- **permissionDecision: "allow":** Never blocks tool calls. Only adds context.

### Task 3: Update PreCompact hook to clean up flush marker
**File:** `hooks/pre-compact.ts` (MODIFY)

After the existing daily log write and compact-pending.json flag (line ~227), add flush-marker cleanup:
```typescript
// Clean up flush marker for next compaction cycle
const FLUSH_MARKER_PATH = path.join(os.homedir(), '.claude-memory', 'flush-marker.json');
try {
  fs.unlinkSync(FLUSH_MARKER_PATH);
} catch {
  // Marker may not exist — that's fine
}
```

This ensures the marker is cleared after compaction, allowing the next cycle to trigger fresh.

### Task 4: Register PreToolUse hook in settings.json
**File:** `~/.claude/settings.json` (MODIFY)

Add one new hook registration under `hooks.PreToolUse`. **No StatusLine registration needed** — it's integrated into the existing `statusline-combined.sh`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [{
          "type": "command",
          "command": "test -f ~/.claude-memory/flush-marker.json && bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pretooluse-memory.ts || true"
        }]
      }
    ]
  }
}
```

**Note:** This is the ONLY settings.json change. The StatusLine detection is handled entirely within `statusline-combined.sh`.

---

## Files to Create / Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `~/.claude/statusline-combined.sh` | Modify | Add ~15 lines: compute used_pct, write flush-marker.json when >65% |
| `hooks/pretooluse-memory.ts` | Create | PreToolUse hook — checks flush marker, staleness, injects additionalContext nudge |
| `hooks/pre-compact.ts` | Modify | Add ~5 lines: clean up flush-marker.json after compaction |
| `~/.claude/settings.json` | Modify | Add PreToolUse hook registration with bash guard |

---

## Performance Considerations

- **StatusLine (every turn):** Zero additional overhead — adds ~15 lines of bash + jq to an already-running script. No new process.
- **PreToolUse (every tool call):** When no marker exists (95%+ of calls): `test -f` = ~2ms. When marker exists: bun startup ~20ms + file read/write ~5ms = ~25ms. One-time cost per compaction cycle.
- **Marker file is <100 bytes** — negligible I/O.
- **One-time nudge** — the `flushed: true` flag ensures the agent is only nudged ONCE per compaction cycle, not on every tool call.

---

## Threshold Tuning

| Setting | Value | Rationale |
|---------|-------|-----------|
| `used_pct threshold` | >65% | Triggers when >65% of context is used (~35% remaining). On 200K window = ~70K tokens remaining. |
| Effective headroom | ~37K tokens | From trigger (70K remaining) to estimated auto-compact (~33K remaining). Agent has ~37K tokens to save memories. |
| Staleness timeout | 30 minutes | Markers older than 30min are deleted on sight by PreToolUse. Prevents stale markers from crashed sessions. |

OpenClaw's equivalent: `softThresholdTokens: 4000` + `reserveTokensFloor: 20000` = flushes at ~24K tokens before compaction. Our 37K token headroom is slightly more generous, giving the agent more room to save.

---

## Testing Strategy

1. **StatusLine detection:** Temporarily change threshold from `65` to `5` in statusline-combined.sh. Run a session, verify flush-marker.json is created after the first turn.
2. **PreToolUse injection:** Create flush-marker.json manually: `echo '{"timestamp":"2026-02-23T12:00:00Z","used_pct":70,"flushed":false}' > ~/.claude-memory/flush-marker.json`. Run any tool call. Verify the agent sees the "STOP — Context nearing compaction" message.
3. **One-time nudge:** After the first injection, verify subsequent tool calls do NOT inject again (flushed: true in marker file).
4. **Staleness check:** Create flush-marker.json with old timestamp (>30min ago). Verify PreToolUse deletes it instead of nudging.
5. **PreCompact cleanup:** Run compaction (or simulate). Verify flush-marker.json is deleted.
6. **Negative test:** Verify that when agent saves memories after nudge, the `flushed: true` flag prevents re-nudging on subsequent tool calls within the same turn.
7. **Full cycle:** Run a long session until auto-compact. Verify: StatusLine detects → PreToolUse nudges → agent saves memories → PreCompact cleans up → SessionStart recovers.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PreToolUse hook slows every tool call | Low | High | Bash `test -f` guard: ~2ms when no marker (95%+ of calls). Bun only starts when marker exists. |
| flush-marker.json not cleaned up (crash) | Low | Low | 30-minute staleness check in PreToolUse. Stale markers auto-deleted. |
| Agent ignores the additionalContext nudge | Medium | Medium | "STOP —" prefix is directive. Auto memory MEMORY.md instructions reinforce memory-writing behavior. PreCompact hook provides backup extraction. |
| Race condition: parallel PreToolUse reads | Low | None | Worst case: two parallel tool calls both see flushed=false, both nudge. Benign — duplicate nudge, not harmful. |
| jq parsing fails in statusline script | Low | Low | Defensive defaults (`// 0`). Failure = no marker written = no nudge. StatusLine display unaffected. |

---

## Rollback Plan

- Revert `~/.claude/statusline-combined.sh` (remove the flush-marker block)
- Delete `hooks/pretooluse-memory.ts`
- Remove PreToolUse registration from settings.json
- Revert pre-compact.ts cleanup lines
- No data loss, no schema changes
