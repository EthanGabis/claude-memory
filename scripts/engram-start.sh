#!/bin/bash
# Source environment (API keys, etc.)
[ -f "$HOME/.claude-memory/.env" ] && source "$HOME/.claude-memory/.env"
exec /Users/ethangabis/.bun/bin/bun /Users/ethangabis/Desktop/Projects/claude-memory/processor/index.ts
