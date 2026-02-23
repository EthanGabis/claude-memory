# Engram V2 System Test Prompt

**Copy-paste this entire prompt into a fresh Claude Code session to run the full test suite.**

---

You are running a comprehensive end-to-end test of the Engram V2 memory system. Test EVERY component systematically. Do NOT skip any section. Report results as PASS/FAIL with details.

## Test Protocol

For each test:
1. Run the check
2. Report: `[PASS]` or `[FAIL] <reason>`
3. If FAIL, note the error but continue to the next test
4. At the end, produce a summary scorecard

Use Bash for shell commands, MCP tools for memory operations. Be precise about what you observe.

---

## SECTION 1: Infrastructure Health (8 tests)

### 1.1 — PID File Exists
```bash
cat ~/.claude-memory/engram.pid
```
Expected: Two lines — PID number on line 1, Unix timestamp (ms) on line 2.

### 1.2 — Daemon Process Alive
```bash
kill -0 $(head -1 ~/.claude-memory/engram.pid) 2>&1 && echo "ALIVE" || echo "DEAD"
```
Expected: `ALIVE` (exit code 0).

### 1.3 — LaunchAgent Loaded
```bash
launchctl list | grep engram
```
Expected: A line containing `com.ethangabis.engram` with PID and status 0.

### 1.4 — UDS Socket Exists
```bash
ls -la ~/.claude-memory/engram.sock
```
Expected: Socket file exists with `srw-------` permissions (owner-only).

### 1.5 — SQLite Database Exists and WAL Mode
```bash
sqlite3 ~/.claude-memory/memory.db "PRAGMA journal_mode;"
```
Expected: `wal`

### 1.6 — Schema Version
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT value FROM _meta WHERE key='schema_version';"
```
Expected: `4`

### 1.7 — Embedding Model Downloaded
```bash
ls ~/.claude-memory/models/*.gguf 2>/dev/null | head -1
```
Expected: At least one `.gguf` file (nomic-embed-text-v1.5).

### 1.8 — Recent Daemon Logs (no crash loops)
```bash
tail -20 ~/.claude-memory/engram.stderr.log
```
Expected: Normal operation messages like `[engram] Processor running`, `[engram] Discovered N sessions`. No repeated crash/restart messages. No `Fatal error`.

---

## SECTION 2: MCP Tool — memory_status (1 test)

### 2.1 — memory_status Returns Valid Report
Call the `memory_status` MCP tool (no parameters).

Expected output contains:
- `Daemon: running` (or similar alive indicator)
- `Schema version: 4`
- Episode count breakdown (may be 0 if fresh)
- Chunk count
- Recollection file count

If daemon shows as not running but Section 1 tests passed, this indicates a UDS or tool detection issue.

---

## SECTION 3: MCP Tool — memory_save (4 tests)

### 3.1 — Save to Daily Log (target=log)
```
memory_save(content="[TEST-LOG] Engram test entry at <current timestamp>", target="log")
```
Expected: Success message. Then verify:
```bash
cat ~/.claude-memory/memory/$(date +%Y-%m-%d).md | grep "TEST-LOG"
```
The test entry should appear with an `## HH:MM` timestamp header.

### 3.2 — Save to MEMORY.md (target=memory)
```
memory_save(content="[TEST-MEM] Engram V2 test entry — unique ID: TEST_<random 6 chars>", target="memory")
```
Expected: Success. Then verify:
```bash
cat ~/.claude-memory/MEMORY.md | grep "TEST-MEM"
```
Entry should exist with ISO timestamp.

### 3.3 — Deduplication (target=memory)
Run the exact same `memory_save` call from 3.2 again with identical content.

Expected: The tool should report that the content already exists (dedup). Verify:
```bash
grep -c "TEST-MEM" ~/.claude-memory/MEMORY.md
```
Count should be exactly `1` (not duplicated).

### 3.4 — Project-Scoped Save (target=log with cwd)
```
memory_save(content="[TEST-PROJECT-LOG] Project-scoped test entry", target="log", cwd="/Users/ethangabis/Desktop/Projects/claude-memory")
```
Expected: Entry saved to the project's `.claude/memory/YYYY-MM-DD.md`, NOT global.
```bash
cat /Users/ethangabis/Desktop/Projects/claude-memory/.claude/memory/$(date +%Y-%m-%d).md 2>/dev/null | grep "TEST-PROJECT-LOG"
```

---

## SECTION 4: MCP Tool — memory_search (4 tests)

### 4.1 — Search Finds Saved Content
```
memory_search(query="Engram V2 test entry")
```
Expected: Returns at least 1 result containing the text from Section 3. Score should be > 0.

### 4.2 — Search With Limit
```
memory_search(query="test", limit=2)
```
Expected: Returns at most 2 results.

### 4.3 — Search With No Results
```
memory_search(query="xyzzy_nonexistent_platypus_quantum_9999")
```
Expected: Returns 0 results or empty list (no errors).

### 4.4 — Search With Project Filter
```
memory_search(query="test", project="claude-memory")
```
Expected: Returns only results from the `claude-memory` project (if any exist). No results from other projects.

---

## SECTION 5: MCP Tool — memory_get (5 tests)

### 5.1 — Read Global MEMORY.md
```
memory_get(path="MEMORY.md")
```
Expected: Returns text content of `~/.claude-memory/MEMORY.md`. `truncated` should be false unless file > 10K chars.

### 5.2 — Read Today's Daily Log
```
memory_get(path="memory/YYYY-MM-DD.md")  # substitute actual date
```
Expected: Returns today's daily log content including the TEST-LOG entry from Section 3.

### 5.3 — Read Non-Existent File
```
memory_get(path="does-not-exist-12345.md")
```
Expected: Returns empty text (NOT an error). This is the documented behavior.

### 5.4 — Path Traversal Attempt
```
memory_get(path="../../etc/passwd")
```
Expected: Error or empty result. Must NOT return system file contents.

### 5.5 — Line Range Slicing
```
memory_get(path="MEMORY.md", startLine=1, lineCount=3)
```
Expected: Returns only the first 3 lines of MEMORY.md.

---

## SECTION 6: MCP Tool — memory_recall (3 tests)

### 6.1 — Recall Returns Episodes
```
memory_recall(query="test")
```
Expected: Returns episode list (may be empty if no extractions yet). Format: `[N] (Date, importance) <summary> — ID: ep_<hex>`. If episodes exist, should have scored results.

### 6.2 — Recall With Limit
```
memory_recall(query="test", limit=1)
```
Expected: Returns at most 1 episode.

### 6.3 — Recall Project Scoping
```
memory_recall(query="test", project="claude-memory")
```
Expected: Only episodes scoped to `claude-memory` project (or global). No episodes from other projects.

---

## SECTION 7: MCP Tool — memory_expand (3 tests)

**Prerequisite:** Section 6 must have returned at least one episode ID. If no episodes exist, note this and skip to Section 8.

### 7.1 — Expand Valid Episode
Take an episode ID from Section 6 results (e.g., `ep_abc123def456`).
```
memory_expand(id="ep_<actual_id>")
```
Expected: Returns formatted markdown with summary, date, project, importance, full_content (if not compressed), entities.

### 7.2 — Expand Non-Existent Episode
```
memory_expand(id="ep_000000000000")
```
Expected: Error message like "Episode not found".

### 7.3 — Expand Invalid ID Format
```
memory_expand(id="not_an_episode_id")
```
Expected: Error about invalid ID format (must start with `ep_`).

---

## SECTION 8: MCP Tool — memory_forget (3 tests)

### 8.1 — Forget Invalid ID Format
```
memory_forget(id="bad_format")
```
Expected: Error about invalid ID format.

### 8.2 — Forget Non-Existent Episode
```
memory_forget(id="ep_000000000000")
```
Expected: Error about episode not found.

### 8.3 — Forget Valid Episode (CAREFUL)
**Only run this if there are test/junk episodes you can safely delete.** Check recall first:
```
memory_recall(query="test entry Engram V2")
```
If there's a test episode from a previous test run, delete it:
```
memory_forget(id="ep_<test_episode_id>")
```
Expected: Success. Verify the episode is gone:
```
memory_recall(query="<the deleted episode's summary>")
```
It should no longer appear.

---

## SECTION 9: Episode Database Integrity (4 tests)

### 9.1 — Episodes Table Has Data
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM episodes;"
```
Expected: A number >= 0 (ideally > 0 if the system has been running). Note the count.

### 9.2 — FTS5 Index Consistent
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM episodes_fts;"
```
Expected: Same count as 9.1 (FTS5 index matches episodes table via triggers).

### 9.3 — Episodes Have Embeddings
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM episodes WHERE embedding IS NOT NULL;"
```
Expected: Most episodes should have embeddings. If 0, embedding pipeline may be broken.

### 9.4 — Chunks Table Indexed
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM chunks;"
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL;"
```
Expected: Chunk count > 0 (memory files are indexed). Most should have embeddings.

---

## SECTION 10: Extraction Pipeline (4 tests)

### 10.1 — State File Exists
```bash
cat ~/.claude-memory/engram-state.json | python3 -m json.tool | head -20
```
Expected: Valid JSON with `sessions` object containing per-session state (byteOffset, messagesSinceExtraction, rollingSummary, etc.).

### 10.2 — Active Sessions Being Tailed
```bash
cat ~/.claude-memory/engram-state.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'Sessions tracked: {len(d[\"sessions\"])}')"
```
Expected: At least 1 session being tracked (this current session, if the daemon is running).

### 10.3 — Recent Extraction Activity
Check daemon logs for extraction messages:
```bash
grep -i "extract" ~/.claude-memory/engram.stderr.log | tail -10
```
Expected: Recent extraction log lines like `Extracted N episodes` or `Extraction complete`. If none, the daemon may not have hit the message threshold yet.

### 10.4 — Recollection Files Exist
```bash
ls -la ~/.claude-memory/recollections/*.json 2>/dev/null | head -5
```
Expected: At least one `.json` file if any sessions have had recollections written. Note: may be empty for very new sessions.

---

## SECTION 11: Recollection Injection (2 tests)

### 11.1 — Hook Script Executable
```bash
file /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pretooluse-recollection.ts
ls -la /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pretooluse-recollection.ts
```
Expected: File exists and is readable.

### 11.2 — Recollection Hook Output Format
Simulate the hook by piping a test payload:
```bash
echo '{"session_id":"test-session-000","tool_name":"Read"}' | bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/pretooluse-recollection.ts 2>/dev/null
```
Expected: Either empty output (no recollection file for test session) OR valid JSON with `hookSpecificOutput.additionalContext` containing `<memory-data>` tags. Should NOT error.

---

## SECTION 12: UDS Communication (2 tests)

### 12.1 — Socket Responsive
```bash
echo '{"event":"ping"}' | nc -U ~/.claude-memory/engram.sock 2>&1; echo "EXIT:$?"
```
Expected: Connection succeeds (no `Connection refused`). The daemon may not respond to `ping` (unknown event), but the socket should accept the connection.

### 12.2 — Flush Signal
```bash
echo '{"event":"flush","sessionId":"nonexistent-test-session"}' | nc -U ~/.claude-memory/engram.sock 2>&1; echo "EXIT:$?"
```
Expected: Connection succeeds. Check daemon logs:
```bash
tail -5 ~/.claude-memory/engram.stderr.log
```
May show `[uds] Flush requested for session nonexist` or silently ignore (no matching tailer). Should NOT crash.

---

## SECTION 13: Project Scoping (3 tests)

### 13.1 — Project Detection
Check that the MCP server detects the current project:
```
memory_status()
```
Look for project name in the output. Should show `claude-memory` or similar.

### 13.2 — Cross-Project Boundary (memory_expand)
If episodes from another project exist, try to expand one from this project context:
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT id, project, scope FROM episodes WHERE scope='project' AND project != 'claude-memory' LIMIT 1;"
```
If a cross-project episode exists, try:
```
memory_expand(id="ep_<that_id>")
```
Expected: Error — "Cannot expand memory from project X — not the current project."

### 13.3 — Cross-Project Boundary (memory_forget)
Same check — attempt to forget a cross-project episode:
```
memory_forget(id="ep_<cross_project_id>")
```
Expected: Error — scope/project boundary rejection.

---

## SECTION 14: Stop Hook (2 tests)

### 14.1 — Stop Hook Script Valid
```bash
bun --version && echo "Bun available"
file /Users/ethangabis/Desktop/Projects/claude-memory/hooks/stop.ts
```
Expected: Bun is installed. Stop hook file exists.

### 14.2 — Stop Hook Dry Run (empty transcript)
```bash
echo '{"session_id":"test-stop-hook","cwd":"/tmp","transcript":"short"}' | bun /Users/ethangabis/Desktop/Projects/claude-memory/hooks/stop.ts 2>/dev/null
echo "EXIT:$?"
```
Expected: Exits cleanly (exit code 0). Short transcript (< 1000 chars) should not trigger nudge or summary.

---

## SECTION 15: Consolidation (2 tests)

### 15.1 — Graduated Episodes
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM episodes WHERE graduated_at IS NOT NULL;"
```
Expected: A number >= 0. If the system has been running long enough with high-importance episodes, some should be graduated.

### 15.2 — Compressed Episodes
```bash
sqlite3 ~/.claude-memory/memory.db "SELECT COUNT(*) FROM episodes WHERE full_content IS NULL AND created_at < (strftime('%s','now')*1000 - 30*86400000);"
```
Expected: Count of episodes older than 30 days with null full_content (compressed by consolidator).

---

## SECTION 16: Error Resilience (3 tests)

### 16.1 — Concurrent PID File
The daemon should reject a second instance:
```bash
# Try to start a second daemon (should fail gracefully)
timeout 5 bun /Users/ethangabis/Desktop/Projects/claude-memory/processor/index.ts 2>&1 | head -5
```
Expected: Message like `Another instance is already running — exiting` and clean exit.

### 16.2 — Database Busy Handling
```bash
sqlite3 ~/.claude-memory/memory.db "PRAGMA busy_timeout;"
```
Expected: `5000` (5 second busy timeout configured).

### 16.3 — Inspect Script
```bash
bun /Users/ethangabis/Desktop/Projects/claude-memory/scripts/inspect.ts 2>/dev/null | head -30
```
Expected: Formatted output showing daemon health, episode breakdown, session states.

---

## FINAL SCORECARD

After all tests complete, produce a table:

```
| Section | Tests | Passed | Failed | Notes |
|---------|-------|--------|--------|-------|
| 1. Infrastructure | 8 | ? | ? | |
| 2. memory_status | 1 | ? | ? | |
| 3. memory_save | 4 | ? | ? | |
| 4. memory_search | 4 | ? | ? | |
| 5. memory_get | 5 | ? | ? | |
| 6. memory_recall | 3 | ? | ? | |
| 7. memory_expand | 3 | ? | ? | |
| 8. memory_forget | 3 | ? | ? | |
| 9. DB Integrity | 4 | ? | ? | |
| 10. Extraction | 4 | ? | ? | |
| 11. Recollection | 2 | ? | ? | |
| 12. UDS | 2 | ? | ? | |
| 13. Project Scope | 3 | ? | ? | |
| 14. Stop Hook | 2 | ? | ? | |
| 15. Consolidation | 2 | ? | ? | |
| 16. Error Resilience| 3 | ? | ? | |
| **TOTAL** | **53** | **?** | **?** | |
```

For any FAIL results, provide:
1. What failed
2. The actual output/error
3. Suggested fix or investigation path
