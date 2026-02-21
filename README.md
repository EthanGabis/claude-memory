# claude-memory

A Claude Code plugin that adds a human-readable, two-layer memory system to your Claude Code sessions. It ports OpenClaw's memory architecture: daily Markdown logs per project, curated MEMORY.md files at both global and project scope, hybrid BM25+vector search with temporal decay, and a pre-compaction flush that saves critical context before Claude's context window rolls over. The plugin runs alongside the existing claude-mem plugin — it adds the Markdown layer that claude-mem is missing without replacing any existing functionality.

---

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later (`curl -fsSL https://bun.sh/install | bash`)
- `OPENAI_API_KEY` environment variable set (used for session summaries via `gpt-4o-mini` and embeddings via `text-embedding-3-small`)

---

## Installation

### 1. Install dependencies

```bash
cd /Users/ethangabis/Desktop/Projects/claude-memory && bun install
```

### 2. Run the install script

```bash
bash /Users/ethangabis/Desktop/Projects/claude-memory/scripts/install.sh
```

This creates the `~/.claude-memory/` directory tree and initialises the SQLite database.

### 3. Set your OpenAI API key

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export OPENAI_API_KEY="sk-..."
```

Then reload your shell or run `source ~/.zshrc`.

### 4. Register hooks and MCP server

The install script does **not** modify `~/.claude/settings.json` automatically. Add the following to your settings:

**Hooks** (`~/.claude/settings.json` → `hooks` object):

```json
"SessionStart": [{
  "hooks": [{
    "type": "command",
    "command": "bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/session-start.ts"
  }]
}],
"Stop": [{
  "hooks": [{
    "type": "command",
    "command": "bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/stop.ts"
  }]
}],
"PreCompact": [{
  "hooks": [{
    "type": "command",
    "command": "bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pre-compact.ts"
  }]
}]
```

**MCP server** (`~/.claude/settings.json` → `mcpServers` object):

```json
"claude-memory": {
  "type": "stdio",
  "command": "bun",
  "args": ["/Users/ethangabis/Desktop/Projects/claude-memory/mcp/server.ts"]
}
```

---

## Usage

### Hooks (automatic)

Once registered, the hooks fire automatically:

- **SessionStart** — injects global and project MEMORY.md + the last 3 daily log entries into the session context (hard cap: 8,000 tokens; oldest logs truncated first).
- **Stop** — summarises the session via `gpt-4o-mini` and appends it to `<project>/.claude/memory/YYYY-MM-DD.md`. Falls back to a plain excerpt if `OPENAI_API_KEY` is unset.
- **PreCompact** — fires when the context window exceeds 150,000 tokens. Extracts critical context via `gpt-4o-mini` and writes it to today's daily log before compaction discards it.

### MCP tools (use in conversation)

Two tools are available via the `claude-memory` MCP server:

- **`memory_search(query, limit?, project?)`** — Hybrid BM25 + vector search with temporal decay. Searches both global and project layers by default; pass `project` to restrict to one project. Results are ranked by combined score with a 30-day half-life decay on dated log files (MEMORY.md files never decay).

- **`memory_save(content, target?)`** — Save content to memory. `target="log"` (default) appends to today's project daily log. `target="memory"` appends to the project MEMORY.md with a dedup check — it never blindly appends if the content already exists.

---

## Migration (claude-mem → claude-memory)

If you have existing history in claude-mem, run the migration pipeline to convert it to Markdown:

```bash
# Step 1: Extract sessions from claude-mem.db and group by project/date
bun run /Users/ethangabis/Desktop/Projects/claude-memory/migrate/extract.ts

# Step 2: Write daily log Markdown files per project
bun run /Users/ethangabis/Desktop/Projects/claude-memory/migrate/write-logs.ts

# Step 3: AI-assisted MEMORY.md generation per project
bun run /Users/ethangabis/Desktop/Projects/claude-memory/migrate/generate-memory.ts
```

Or run all three steps at once:

```bash
cd /Users/ethangabis/Desktop/Projects/claude-memory && bun run migrate
```

**Safety:** The migration script never overwrites existing files. If a daily log already exists at the target path, it appends under a `<!-- migrated -->` separator. If a project path no longer exists on the filesystem, its logs are archived to `~/.claude-memory/memory/archive/`.

---

## File Structure

```
~/.claude-memory/                     ← Global layer
├── MEMORY.md                         ← Global facts about the developer (grows over time)
├── memory/
│   └── YYYY-MM-DD.md                 ← Global daily logs (orphan sessions)
├── memory.db                         ← SQLite: FTS5 chunks + float32 embeddings
└── flush-state.json                  ← Tracks pre-compact flush per session ID

<project>/.claude/memory/             ← Project layer (per repository)
├── MEMORY.md                         ← Project facts, stack decisions, key learnings
└── YYYY-MM-DD.md                     ← Project daily session logs
```

The two-layer design means:
- **Global layer** accumulates facts about you as a developer across all projects (preferred tools, coding style, recurring patterns).
- **Project layer** accumulates facts specific to a single codebase (architecture decisions, known gotchas, current work-in-progress).

Both layers are plain Markdown — readable, editable, and version-controllable without any special tooling.

---

## Rollback

The plugin is purely additive. To remove it:

1. Remove the `SessionStart`, `Stop`, and `PreCompact` hook entries from `~/.claude/settings.json`
2. Remove the `claude-memory` entry from `mcpServers` in `~/.claude/settings.json`
3. Delete `~/Desktop/Projects/claude-memory/` (or wherever you cloned it)
4. Optionally delete `~/.claude-memory/` (this deletes all your memory data)

The existing claude-mem plugin continues running unaffected. Project `.claude/memory/` folders remain as plain Markdown.
