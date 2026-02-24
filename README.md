# claude-memory

Human-like memory for Claude Code.

## How it works

claude-memory is a two-process system that gives Claude Code persistent, searchable memory across sessions:

1. **MCP Server** (`mcp/server.ts`) -- Runs inside Claude Code via stdio. Provides tools for searching, saving, recalling, and expanding memories. Maintains a SQLite database with FTS5 full-text search and vector embeddings.

2. **Engram Processor** (`processor/index.ts`) -- A background daemon that tails active session JSONL files, extracts episodic memories via LLM, writes pre-computed recollections, and periodically consolidates stale episodes. Runs as a macOS LaunchAgent.

Five **hooks** connect the system to Claude Code's lifecycle: injecting memory context at session start, nudging memory saves before stop, flushing context before compaction, injecting recollections before tool use, and nudging memory saves before compaction.

Data is stored in two layers -- a **global layer** (`~/.claude-memory/`) for cross-project knowledge and a **project layer** (`<project>/.claude/memory/`) for per-repository context. Both are plain Markdown files backed by a shared SQLite index.

## Prerequisites

- [Bun](https://bun.sh) v1.0+ (`curl -fsSL https://bun.sh/install | bash`)
- `OPENAI_API_KEY` environment variable (used for session summaries via `gpt-4o-mini`, memory extraction via `gpt-4.1-nano`, and embeddings via `text-embedding-3-small` as fallback)
- macOS (LaunchAgent for the Engram processor daemon)

## Installation

### 1. Install dependencies

```bash
cd /path/to/claude-memory && bun install
```

### 2. Run the install script

```bash
bash /path/to/claude-memory/scripts/install.sh
```

Creates `~/.claude-memory/`, initializes the SQLite database, and downloads the local embedding model (nomic-embed-text-v1.5 GGUF, ~260MB first run).

### 3. Set your OpenAI API key

Add to `~/.zshrc` (or `~/.claude-memory/.env` for the daemon):

```bash
export OPENAI_API_KEY="sk-..."
```

### 4. Register hooks and MCP server

Add to `~/.claude/settings.json`:

**Hooks:**

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun /path/to/claude-memory/hooks/session-start.ts" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun /path/to/claude-memory/hooks/stop.ts" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "bun /path/to/claude-memory/hooks/pre-compact.ts" }] }],
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "bun /path/to/claude-memory/hooks/pretooluse-recollection.ts" }] },
      { "hooks": [{ "type": "command", "command": "bun /path/to/claude-memory/hooks/pretooluse-memory.ts" }] }
    ]
  }
}
```

**MCP server:**

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/claude-memory/mcp/server.ts"]
    }
  }
}
```

### 5. Install the LaunchAgent (Engram processor daemon)

Edit `scripts/com.ethangabis.engram.plist` to match your paths, then:

```bash
cp scripts/com.ethangabis.engram.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ethangabis.engram.plist
```

The daemon starts on login and restarts on crash. Logs go to `~/.claude-memory/engram.stderr.log`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_search(query, limit?, project?)` | Hybrid BM25 + vector search with temporal decay (30-day half-life). Returns ranked results with file path, line range, score, and snippet. |
| `memory_get(path, startLine?, lineCount?)` | Read a specific memory file by workspace-relative path. 10K char cap. |
| `memory_save(content, target?, cwd?)` | Save to daily log (`target="log"`, default) or MEMORY.md (`target="memory"`, with dedup). |
| `memory_recall(query, limit?, project?)` | Get short "memory bites" from the episodes table blended with "belief bites" from the beliefs table. Scored by relevance, recency, and access frequency. |
| `memory_expand(id)` | Expand an episode (`ep_*`) or belief (`bl_*`) ID to get full context. For beliefs: statement, structured fields, confidence (alpha/beta), evidence chains, revision history, and parent/child links. |
| `memory_forget(id)` | Delete a specific episode (`ep_*`) or belief (`bl_*`) by ID. Use to remove incorrect or outdated memories. |
| `memory_status()` | Check Engram daemon health, episode counts, schema version, and system status. |

## Hooks

| Hook | Trigger | Behavior |
|------|---------|----------|
| **SessionStart** | New session | Injects global + project MEMORY.md and last 3 daily logs into context (8K token cap). Detects post-compaction recovery. |
| **Stop** | Session end | Blocks once to nudge memory saves if session was substantive. Summarizes transcript via `gpt-4o-mini` and appends to daily log. Sends UDS flush signal to daemon for final extraction. |
| **PreCompact** | Context > 150K tokens | Extracts critical context via `gpt-4o-mini`, writes to daily log, sets compact-pending flag. |
| **PreToolUse (recollection)** | Before each tool call | Reads pre-computed recollection file from Engram processor, injects memory bites as `additionalContext`. Deduped per user message UUID. Skips stale (>5min) recollections if daemon is dead. <5ms. |
| **PreToolUse (memory)** | Before each tool call | One-shot nudge to save durable knowledge when compaction is imminent (flush-marker based). |

## Engram Processor

The Engram processor (`bun processor/index.ts`) is a long-running daemon that:

- **Session tailing** -- Watches `~/.claude/projects/*/` for JSONL session files. Tails each active session with byte-offset tracking and crash recovery via `engram-state.json`.
- **Memory extraction** -- After the first 5 messages (then every 15 messages or 20 minutes), sends the conversation buffer to `gpt-4.1-nano` to extract episodic memories (summary, full context, entities, importance, scope). Deduplicates against existing episodes via cosine similarity (>0.92 threshold = append-update instead of insert). Retries with exponential backoff (15s-120s) on failure.
- **Recollection writing** -- On each user message, embeds it locally (~5ms via nomic-embed-text GGUF), checks for topic change (cosine sim < 0.85 with previous message), and writes the top 3 relevant memory bites to `~/.claude-memory/recollections/<sessionId>.json` for the PreToolUse hook to pick up. Scoring uses Laplace-smoothed access frequency and a high-importance relevance floor.
- **Hook-daemon communication** -- UDS socket at `~/.claude-memory/engram.sock` accepts flush signals from the stop hook so buffered messages are extracted before session JSONL goes stale.
- **Consolidation** -- Every 4 hours: graduates high-importance, frequently-accessed episodes (or those older than 14 days) to global MEMORY.md, compresses stale low-access episodes by dropping `full_content`, and runs **belief consolidation** -- clustering recent episodes by embedding similarity, synthesizing generalized beliefs via `gpt-4.1-mini`, and updating existing beliefs through reinforcement, contradiction, revision, split, merge, and archival. MEMORY.md is capped at 200 lines with overflow archived to monthly files.

Singleton enforcement via PID file (`~/.claude-memory/engram.pid`). Memory-limited to 512MB RSS with automatic restart.

## Diagnostic CLI

```bash
bun scripts/inspect.ts          # pretty-print
bun scripts/inspect.ts --json   # machine-readable
```

Shows: daemon health (PID, uptime), schema version, episode counts by project/scope/importance, active session states (byte offset, pending messages, recollection status), and recent extractions.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Used for session summaries, memory extraction, and fallback embeddings |
| `ENGRAM_TOPIC_THRESHOLD` | `0.85` | Cosine similarity threshold for topic-change gate in recollection writer |

Internal constants (edit in source):

| Constant | Value | Location |
|----------|-------|----------|
| Token threshold for PreCompact | 150,000 | `hooks/pre-compact.ts` |
| Session start context cap | 8,000 tokens | `hooks/session-start.ts` |
| Extraction trigger (messages) | 5 initial, 15 standard | `processor/session-tailer.ts` |
| Extraction trigger (time) | 20 min | `processor/session-tailer.ts` |
| Consolidation interval | 4 hours | `processor/index.ts` |
| Graduation min access count | 3 | `processor/consolidator.ts` |
| Compression age | 30 days | `processor/consolidator.ts` |
| Episode similarity dedup | 0.92 | `processor/extractor.ts` |
| Memory RSS limit | 512 MB | `processor/index.ts` |
| Temporal decay half-life | 30 days | `mcp/search.ts` |
| Belief consolidation episode threshold | 20 | `processor/belief-utils.ts` |
| Min cluster size for belief | 3 | `processor/belief-utils.ts` |
| Belief reinforce cosine threshold | 0.92 | `processor/belief-utils.ts` |
| Min confidence for recall | 0.4 | `processor/belief-utils.ts` |
| Max belief bites per recall | 2 | `processor/belief-utils.ts` |
| Consolidation cycle budget | 120s | `processor/belief-utils.ts` |

## Evaluation Harness

Offline IR evaluation for measuring and optimizing retrieval quality. Lives in `eval/`.

```bash
# Build dataset from production episodes (requires ANTHROPIC_API_KEY)
bun run eval/run.ts dataset

# Run parameter ablation (e.g., sweep BM25 weight)
bun run eval/run.ts ablation --sweep wBm25

# Compare RRF vs legacy retriever
bun run eval/run.ts ablation --baseline

# Latency benchmark
bun run eval/run.ts benchmark

# View results table
bun run eval/run.ts report
```

Sweep parameters: `wBm25`, `wRecency`, `wAccess`, `minVectorSim`, `k`, or `all`. Results are saved as JSONL in `eval/results/`.

See [docs/features/2026-02-24-eval-harness.md](docs/features/2026-02-24-eval-harness.md) for full documentation.

## Belief System (Semantic Memory)

Engram includes a semantic memory layer that extracts generalized beliefs from episodic memory using a neuroscience-grounded consolidation pipeline. Beliefs are living hypotheses with Bayesian confidence tracking (Beta-Bernoulli distribution) that strengthen with reinforcement and weaken with contradictions. They follow a full lifecycle: creation from episode clusters, reinforcement, contradiction, revision, split, merge, decay, and archival. Beliefs are surfaced as "belief bites" alongside episode "memory bites" in `memory_recall` and pre-computed recollections.

Key design properties:
- **Complementary Learning Systems**: episodes (hippocampus) + beliefs (neocortex) with batch consolidation
- **Beta-Bernoulli confidence**: `confidence = alpha / (alpha + beta)`, naturally resistant to change with accumulated evidence
- **Dual-strength model**: storage strength (evidence_count, monotonic) + retrieval strength (exponential decay with spaced-repetition stability bonus)
- **Rule-based gates**: split, merge, revision, and archival are gated by deterministic thresholds, not LLM decisions
- **Materialized views**: beliefs are derived from episodes and can be rebuilt from scratch

See [docs/features/2026-02-24-belief-system.md](docs/features/2026-02-24-belief-system.md) for full documentation.

## Architecture

```
Claude Code Session
  |
  |-- [SessionStart hook] --> reads MEMORY.md + daily logs --> injects context
  |
  |-- [PreToolUse hooks] --> reads recollection file --> injects memory bites
  |                      --> checks flush-marker --> nudges memory save
  |
  |-- [MCP tools] --> memory_search/save/get/recall/expand <--> SQLite (FTS5 + vectors)
  |
  |-- [PreCompact hook] --> extracts context via LLM --> writes to daily log
  |
  |-- [Stop hook] --> nudges memory save --> summarizes session --> writes daily log
  |                                          \--> UDS flush signal to daemon
  |
  |                          ~/.claude/projects/*/*.jsonl
  |                                     |
  |                                     v
  |                          Engram Processor (daemon)
  |                            |           |          |
  |                     Session Tailer  Recollection  Consolidator
  |                     (tail JSONL)    Writer        (4h cycle)
  |                            |           |
  |                       gpt-4.1-nano    nomic-embed
  |                       (extraction)    (local GGUF)
  |                            |           |
  |                            v           v
  |                         episodes    recollections/
  |                         table       <session>.json
  |
  v
~/.claude-memory/
  ├── memory.db          (SQLite: chunks FTS5 + episodes + beliefs + embeddings)
  ├── MEMORY.md          (global durable facts, 200-line cap)
  ├── engram.pid         (daemon singleton lock)
  ├── engram.sock        (UDS socket for hook-daemon communication)
  ├── engram-state.json  (session byte offsets, rolling summaries)
  ├── recollections/     (pre-computed memory bites per session)
  ├── archive/           (monthly MEMORY.md overflow archives)
  └── memory/            (global daily logs)

<project>/.claude/memory/
  ├── MEMORY.md          (project-specific facts)
  └── YYYY-MM-DD.md      (project daily logs)
```
