# R&D Findings: Automatic Transcript Recorder

**Date:** 2026-02-23
**Feature Summary:** Automatic transcript-based memory recorder that watches Claude Code .jsonl files, feeds them through a cheap LLM, and writes into the existing claude-memory system.

## Codebase Analysis

### Existing System
- claude-memory MCP server at ~/Desktop/Projects/claude-memory/
- 3 tools: memory_save, memory_search, memory_get
- 4 hooks: session-start, stop, pre-compact, pretooluse-memory
- Indexer: 400-token overlapping chunks, FTS5 + embedding BLOBs, SQLite WAL mode
- File watcher: chokidar on .md files in memory dirs, auto-reindex on changes

### Transcript Files
- Location: ~/.claude/projects/&lt;encoded-project-path&gt;/&lt;session-uuid&gt;.jsonl
- 238 main session files across 7 project directories
- Sizes: 500KB to 71MB; 6,228-12,169 lines for large sessions
- Entry types: user, assistant, system, progress, file-history-snapshot
- Only user + assistant entries needed for summarization (~30% of lines)
- sessions-index.json provides session metadata (summaries, timestamps, message counts)

### Integration Points
- indexFile() exported from mcp/indexer.ts — can be called directly
- Daily log format: ## HH:MM Section headers with content
- Stop hook already does gpt-4o-mini summarization (30K char cap)
- File watcher auto-reindexes .md files in watched directories

## LLM Pricing Research

### Cost Per Session (50K input tokens, 500 output tokens)

| Model | Cost/Session | Monthly (600 sessions) |
|-------|-------------|----------------------|
| Ollama local | $0.00 | $0.00 |
| GPT-4.1-nano batch | $0.0005 | $0.33 |
| GPT-4.1-nano | $0.0011 | $0.65 |
| Gemini 2.0 Flash batch | $0.0026 | $1.56 |
| Gemini 2.0 Flash | $0.0052 | $3.12 |
| GPT-4o-mini batch | $0.0039 | $2.34 |
| GPT-4o-mini | $0.0078 | $4.68 |
| Gemini 2.5 Flash | $0.0164 | $9.82 |
| GPT-4.1-mini | $0.0208 | $12.48 |
| Claude Haiku 4.5 | $0.0525 | $31.50 |

### Free Tier
- Gemini 2.5 Flash: 250 requests/day free (covers 20 sessions/day)
- Gemini 2.5 Flash-Lite: 1,000 requests/day free

### Winner: GPT-4.1-nano at $0.65/month (or $0.33 batch)

## File Watching Research

### Recommended: Chokidar v5
- Battle-tested (30M repos), FSEvents native on macOS
- awaitWriteFinish option for detecting session completion
- ESM-only, TypeScript built-in, works with Bun

### Session End Detection (Multi-Signal)
1. Inactivity timeout (30s no writes) — primary signal
2. Process detection (ps grep for session ID) — confirmation
3. stop_hook_summary in JSONL — definitive signal
4. sessions-index.json updates — backup signal

### Persistence: macOS LaunchAgent
- ~/Library/LaunchAgents/com.ethangabis.transcript-watcher.plist
- KeepAlive: true for auto-restart on crash
- RunAtLoad: true for auto-start on login

### Prior Art
- claude-mem (thedotmack): Full plugin with observer subprocesses. Leaked 157 zombies (8.4GB). Fixed via ensureProcessExit() + reapStaleSessions() daemon
- simonw/claude-code-transcripts: JSONL to HTML converter
- daaain/claude-code-log: Python JSONL to Markdown

## Key Insights
- GPT-4.1-nano is absurdly cheap ($0.65/month) with 1M context window — handles any transcript
- Gemini free tier can cover all 600 sessions/month at $0 (if regional restrictions don't apply)
- The existing stop hook already does LLM summarization — the recorder is essentially a more reliable version of the same pattern
- claude-mem's zombie process leak is a cautionary tale — process management must be bulletproof
- sessions-index.json is an underutilized resource — contains first prompts and AI-generated summaries

## Assumptions to Validate
- GPT-4.1-nano quality is sufficient for transcript summarization (importance: high, evidence: medium)
- Gemini free tier is available in Israel/EU (importance: medium, evidence: low)
- 30-second inactivity timeout reliably detects session end (importance: high, evidence: medium)
- LaunchAgent with KeepAlive prevents all process death scenarios (importance: high, evidence: high)
