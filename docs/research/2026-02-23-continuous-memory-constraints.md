# Research: Continuous Memory for Multi-Day, Multi-Session Claude Code Usage

**Date:** 2026-02-23
**Question:** How to build memory that works for sessions lasting days, 5+ concurrent sessions sharing memory, and continuous recollection throughout (not just at session start)?

---

## User's Real Usage Pattern

- Sessions last **days** (2-3 days continuous)
- **5+ concurrent sessions** running simultaneously on different projects
- Topics change **multiple times** within a single session
- All sessions need **shared global memory** + their own **project-specific memory**
- Recollections must happen **continuously**, not just at session start
- Agent should get brief "bites" and **choose** to expand or dismiss

---

## Finding 1: JSONL Transcripts Are Perfect for Streaming

The transcript files at `~/.claude/projects/<path>/<session>.jsonl` are:
- **Append-only** — lines are never modified after writing
- **No file locks** — safe to read from external processes
- **Never truncated on compaction** — compaction appends a `compact_boundary` entry, then continues
- **6 entry types**: user (10.8%), assistant (16.3%), progress (65.9%), system (2.7%), file-history-snapshot (1.8%), queue-operation (2.6%)
- **Only user + assistant matter** for memory extraction (~27% of lines)
- **Average session**: ~9.3 lines per conversation turn, files grow to 10-60MB

**Tool for tailing**: `@logdna/tail-file` — zero-dependency, tracks byte offset for resume, streams new lines as they're appended.

---

## Finding 2: Three-Tier Processing Pipeline (Hot/Warm/Cold)

### Hot Path — Every Message (local, cheap)
- Compute turn embedding using local sentence transformer
- Sliding window cosine similarity for **topic change detection**
- 95.6% recall, 0% false positive on topic boundaries
- **No LLM calls** — pure embedding math

### Warm Path — Micro-Batch (on trigger)
Triple trigger fires when ANY of these occurs:
1. **15+ new messages** accumulated
2. **20 minutes** elapsed since last processing
3. **Topic change detected** (cosine similarity drops below 0.70)

Processing: Single LLM call with `{previous_summary + new_messages}` → extract candidate memories → Mem0-style ADD/UPDATE/DELETE/NOOP against existing store.

### Cold Path — Periodic (every few hours)
- Deep consolidation: merge duplicates, resolve contradictions, reorganize by topic
- Update MEMORY.md with graduated semantic knowledge
- Compress old episodic entries

---

## Finding 3: SQLite Handles 5 Concurrent Sessions Fine

- **WAL mode** = readers never block writers, writers never block readers
- 5 sessions is **well within SQLite's comfort zone** (problems only at 100s+ concurrent writers)
- **Connection recipe**: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE` for all writes
- **Memory scoping**: single `memories` table with `scope` (global/project) + `project_id` column
- Session A (TrueTTS) sees: `WHERE scope='global' OR project_id='TrueTTS'`
- **Cross-session propagation**: chokidar watches DB directory → `PRAGMA data_version` → refresh cache (0-3 second latency)
- **Conflict resolution**: Last-Write-Wins with semantic dedup (all sessions on same machine, so wall clock is reliable)

---

## Finding 4: Continuous Recollection Without Context Rot — The Breakthrough

### The Problem
- Context rot: LLM performance degrades as context fills
- Proactive interference: each injected memory causes **log-linear, monotonic, irreversible** accuracy decline
- Lost-in-middle: LLMs attend to beginning and end, ignore middle

### The Solution: Model Human Involuntary Autobiographical Memory (IAMs)

Humans experience ~20-30 involuntary memories per day. They are:
- Triggered by **distinctive feature overlap** with the current situation
- **Brief** — a flash, not full replay
- **Suppressed during focused work** (demanding tasks reduce IAMs)
- Biased toward **recent events** and **unfinished tasks** (Zeigarnik effect)

### The Complete Recollection System

**1. Trigger Detection** (not every turn — topic-change-gated)
- Topic-change detector fires when conversation embedding shifts (cosine sim drops below 0.70)
- Frequency cap: max 1-2 recollections per topic change, ~20-30 per entire session
- Suppress during deep focus (complex code generation, multi-step debugging)

**2. Relevance Gate** (threshold prevents noise)
- Cosine similarity between current context embedding and stored memories
- Threshold: 0.75+ (below 0.20 precision, RAG actively harms performance)
- Zeigarnik boost: unfinished tasks get +0.1 relevance bonus

**3. "Memory Bite" Format** (brief, human-like)
```
[Memory flash: On Feb 20, you and the user fixed a WebSocket race condition by adding a mutex on the connection map in server.ts:142]
```
- Max 40 tokens per bite (research: >10 word values → <40% accuracy from interference)
- Max 3 per injection event
- Placed at recency position (just before latest user message) — NEVER middle
- Extractive, not abstractive (extractive outperforms abstractive at compression)

**4. Agent-Controlled Expansion** (the "choose to remember" pattern)
- Agent sees the bite and decides: relevant or redundant?
- If relevant: calls `memory_expand(recollection_id)` → gets 2-3 paragraphs of full context + related memories
- If redundant: ignores it, moves on
- The agent feels like it's **remembering**, not being told

**5. Compaction as Sleep**
- Compaction resets the interference counter (old injections gone)
- Pre-compaction: write episodic memories to persistent storage
- Post-compaction: re-evaluate relevance, selective re-injection with fresh context
- Include "memory manifest" in compaction summary so post-compaction agent knows what was active

### Key Numbers
| Parameter | Value | Source |
|-----------|-------|--------|
| Relevance threshold | 0.75 cosine | RAG precision research |
| Max per injection | 3 bites | 5-6 saturation point, leave headroom |
| Max per session | 20-30 total | Human IAM frequency |
| Max tokens per bite | 40 | Proactive interference paper |
| Injection trigger | Topic change | IAM trigger research |
| Micro-batch trigger | 15 msgs / 20 min / topic change | Cost-quality balance |
| Cross-session sync | 0-3 seconds | chokidar + data_version |

---

## Revised Architecture: Engram V2

```
                     ┌──────────────────────────────────┐
                     │  5 Concurrent Claude Code Sessions │
                     │  (each lasting days)               │
                     └──────┬───┬───┬───┬───┬────────────┘
                            │   │   │   │   │
                     ┌──────┴───┴───┴───┴───┴────────────┐
                     │  Shared SQLite Memory DB (WAL)      │
                     │  ┌─────────────────────────────────┐│
                     │  │ scope=global  → all sessions    ││
                     │  │ scope=project → filtered by     ││
                     │  │                 project_id      ││
                     │  └─────────────────────────────────┘│
                     └──────────────┬──────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
    ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐
    │ TRANSCRIPT       │  │ RECOLLECTION     │  │ AGENT MEMORY     │
    │ PROCESSOR        │  │ ENGINE           │  │ TOOLS (MCP)      │
    │                  │  │                  │  │                  │
    │ Tails all active │  │ Topic-change     │  │ memory_search()  │
    │ JSONL files      │  │ triggered        │  │ memory_save()    │
    │                  │  │                  │  │ memory_recall()  │
    │ HOT: embed turns │  │ Relevance-gated  │  │ memory_expand()  │
    │ detect topics    │  │ (cosine > 0.75)  │  │                  │
    │                  │  │                  │  │ Agent decides     │
    │ WARM: micro-batch│  │ "Memory bites"   │  │ what to save     │
    │ extract memories │  │ (max 40 tokens)  │  │ and when to      │
    │ ADD/UPDATE/DEL   │  │                  │  │ search            │
    │                  │  │ Agent chooses to  │  │                  │
    │ COLD: consolidate│  │ expand or dismiss │  │                  │
    │ graduate to      │  │                  │  │                  │
    │ MEMORY.md        │  │ Max 3 per event  │  │                  │
    │                  │  │ ~20-30 per session│  │                  │
    └─────────────────┘  └──────────────────┘  └──────────────────┘
```

### How It Maps to Human Memory

| Human | System | Mechanism |
|-------|--------|-----------|
| Hippocampal auto-encoding | Transcript processor tailing JSONL | Automatic, no conscious effort |
| Sleep consolidation | Cold path (periodic deep processing) | Compress, abstract, graduate |
| Involuntary autobiographical memory | Recollection engine (topic-change gated) | Brief flash, distinctive feature overlap |
| Tip-of-the-tongue → full recall | Memory bite → memory_expand() | Brief cue → choose to retrieve more |
| Zeigarnik effect | Unfinished tasks get relevance boost | Incomplete work stays accessible |
| Working memory (4±1 items) | Max 3 bites per injection, 40 tokens each | Limited capacity, high relevance |
| Shared knowledge | Global memory scope | Accessible across all contexts |
| Context-specific memory | Project-scoped memory | Only surfaces in relevant project |

---

## Open Questions for Implementation

1. **Which sentence transformer for local topic detection?** (all-MiniLM-L6-v2? nomic-embed-text?)
2. **Which LLM for warm-path extraction?** (GPT-4.1-nano at ~$0.007/session? Gemini free tier?)
3. **How to inject recollections into active sessions?** (PreToolUse hook with relevance gate? New hook type?)
4. **How to detect "deep focus" for suppression?** (consecutive tool_use entries? code generation patterns?)
5. **How to handle the Zeigarnik boost?** (track unresolved questions/TODOs across sessions?)
6. **Byte offset persistence for crash recovery** — where to store per-session read positions?
