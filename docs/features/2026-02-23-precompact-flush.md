# Pre-Compaction Memory Flush

**Date:** 2026-02-23
**Status:** Implemented
**Plan:** docs/plans/2026-02-23-precompact-flush.md

## Overview

4-hook chain that prompts the agent to save memories BEFORE compaction — matching OpenClaw's pre-compaction memory flush behavior. The agent is nudged while full context is still available, not after it's been lost.

## How It Works

1. **StatusLine (detect):** Every turn, `statusline-combined.sh` computes context usage from raw token counts. When >65% used (~35% remaining), writes `flush-marker.json`.

2. **PreToolUse (nudge):** On the next tool call, a bash guard checks for `flush-marker.json` with `flushed:false`. If found, bun runs `pretooluse-memory.ts` which injects `additionalContext` telling the agent to save memories. Sets `flushed:true` to prevent re-nudging.

3. **PreCompact (backup):** When compaction fires, `pre-compact.ts` extracts context via gpt-4o-mini (existing behavior) and cleans up `flush-marker.json`.

4. **SessionStart (recovery):** Post-compaction, loads MEMORY.md + daily logs and nudges re-orientation (existing behavior).

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `~/.claude/statusline-combined.sh` | Modified | Added ~15 lines: compute used_pct, write flush-marker.json when >65% |
| `hooks/pretooluse-memory.ts` | Created | PreToolUse hook — staleness check, flushed flag, additionalContext injection |
| `hooks/pre-compact.ts` | Modified | Added flush-marker.json cleanup after compaction |
| `~/.claude/settings.json` | Modified | Added PreToolUse hook with bash grep guard |

## Architecture Decisions

- **Integrated into statusline-combined.sh** rather than creating a new file because `statusLine` is a singleton setting (only one command allowed)
- **Raw token computation** instead of `remaining_percentage` for backward compatibility with older Claude Code versions
- **Bash `test -f` + `grep -q` guard** avoids bun startup on 95%+ of tool calls (~2ms overhead vs ~25ms)
- **30-minute staleness timeout** prevents crashed sessions from causing spurious nudges
- **Invalid timestamp validation** (`Number.isFinite`) ensures corrupted markers are cleaned up

## Configuration

| Setting | Value | Location |
|---------|-------|----------|
| Usage threshold | >65% | `statusline-combined.sh` line 19 |
| Staleness timeout | 30 minutes | `pretooluse-memory.ts` line 26 |
| Marker file | `~/.claude-memory/flush-marker.json` | All hooks |

## Testing Notes

- Test by temporarily lowering threshold from 65 to 5 in statusline-combined.sh
- Manual marker creation: `printf '{"timestamp":"%s","used_pct":70,"flushed":false}' "$(date -u +%FT%TZ)" > ~/.claude-memory/flush-marker.json`
- Verify nudge by running any tool call after creating marker
- Full regression: 11 test cases, all passing (see test report in session logs)
