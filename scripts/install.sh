#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MEMORY_DIR="$HOME/.claude-memory"
MEMORY_LOG_DIR="$MEMORY_DIR/memory"
MEMORY_ARCHIVE_DIR="$MEMORY_DIR/memory/archive"
GLOBAL_MEMORY_FILE="$MEMORY_DIR/MEMORY.md"

# Check for bun
if ! command -v bun &>/dev/null; then
  echo "[claude-memory] ERROR: bun is not installed or not on PATH. Please install from https://bun.sh" >&2
  exit 1
fi

echo "[claude-memory] Starting installation..."

# 1. Create ~/.claude-memory/ directory tree
mkdir -p "$MEMORY_DIR"
echo "[claude-memory] Created $MEMORY_DIR"

mkdir -p "$MEMORY_LOG_DIR"
echo "[claude-memory] Created $MEMORY_LOG_DIR"

mkdir -p "$MEMORY_ARCHIVE_DIR"
echo "[claude-memory] Created $MEMORY_ARCHIVE_DIR"

# 2. Create empty MEMORY.md if it doesn't already exist
if [ ! -f "$GLOBAL_MEMORY_FILE" ]; then
  printf '# Global Memory\n\n' > "$GLOBAL_MEMORY_FILE"
  echo "[claude-memory] Created $GLOBAL_MEMORY_FILE"
else
  echo "[claude-memory] $GLOBAL_MEMORY_FILE already exists — skipping"
fi

# 3. Initialise the SQLite database by running the schema init
echo "[claude-memory] Initialising SQLite database..."
bun -e "
(async () => {
  const { initDb, DB_PATH } = await import('$PLUGIN_ROOT/mcp/schema.ts');
  const db = initDb(DB_PATH);
  db.close();
  console.error('[claude-memory] Database initialised at ' + DB_PATH);
})();
"

# 4. Install LaunchAgent for Engram daemon
PLIST_SRC="$SCRIPT_DIR/com.ethangabis.engram.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.ethangabis.engram.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$LAUNCH_AGENTS_DIR"

# Unload existing agent if loaded (ignore errors if not loaded)
launchctl bootout "gui/$(id -u)/com.ethangabis.engram" 2>/dev/null || true

# Symlink the plist (force overwrite if exists)
ln -sf "$PLIST_SRC" "$PLIST_DST"
echo "[claude-memory] Symlinked LaunchAgent plist to $PLIST_DST"

# Load the agent
launchctl load "$PLIST_DST"
echo "[claude-memory] Loaded LaunchAgent com.ethangabis.engram"

echo "[claude-memory] Installation complete."
