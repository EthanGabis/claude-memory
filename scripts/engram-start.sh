#!/bin/bash
# macOS LaunchAgents can't access ~/Desktop without Full Disk Access.
# Use absolute paths and set HOME-based working directory to avoid restrictions.
PLUGIN_ROOT="/Users/ethangabis/Desktop/Projects/claude-memory"
cd "$HOME" || cd /tmp
exec /Users/ethangabis/.bun/bin/bun --env-file="$HOME/.claude-memory/.env" "$PLUGIN_ROOT/processor/index.ts"
