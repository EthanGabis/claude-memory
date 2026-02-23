# Research: Engram Architecture Validation — Is This the Best Way?

**Date:** 2026-02-23
**Question:** Is the proposed Engram architecture (background consolidation + association graph + spreading activation + recollection injection + importance scoring) actually the best approach, or are we over-engineering?

---

## Verdict: The Full Engram Design is Over-Engineered

The validation round surfaced **4 CRITICAL** and **3 SERIOUS** issues. Production evidence from Mem0, Zep, and Letta shows that complex systems yield marginal gains over simpler approaches while dramatically increasing failure surface.

**The killer finding:** Mem0's graph-enhanced variant only achieves ~2% higher accuracy than the base (non-graph) version. Simple approaches capture 80-90% of the value.

---

## What We Should KEEP from Engram

| Component | Why It's Validated |
|-----------|-------------------|
| Automatic transcript capture | Every production system does this. The #1 gap in our current system. |
| Episodic + semantic separation | Validated by neuroscience (CLS theory) AND every 2025 system (Mem0, Zep, Letta, EVOLVE-MEM) |
| Background consolidation worker | Correct concept, but must be simple and bulletproof (not a complex daemon) |
| Hybrid retrieval (BM25 + vector) | Universal best practice. Our existing system already does this. |
| Two-stage recollection (cue → expand) | Validated by cognitive science and all modern IR systems |

## What We Should KILL

| Component | Why It's Wrong |
|-----------|---------------|
| **Association graph + spreading activation** | Degrades to noise at scale. Mem0's graph adds only 2% accuracy. Worst effort-to-value ratio. |
| **LLM pointwise importance scoring (1-10)** | Research shows it's the LEAST reliable form of LLM judgment. Cascading failures downstream. |
| **Ebbinghaus temporal decay** | Wrong model for coding agents. Based on nonsense syllables. Architectural decisions should never decay. |
| **Continuous recollection injection (PreToolUse)** | Context rot, lost-in-middle effect, proactive interference. Each injected memory MONOTONICALLY degrades LLM performance. |
| **Reflection engine** | Depends on unreliable importance scoring. Premature complexity. |

## What We Should CHANGE

| Original Design | Better Approach | Evidence |
|----------------|----------------|----------|
| Fixed retrieval weights (0.3/0.3/0.4) | Adaptive or simpler (just recency + relevance, drop importance) | ACAN paper, "Learn to Memorize" 2025 |
| Ebbinghaus exponential decay | Category-aware persistence + usage-based reinforcement | Bjork's storage/retrieval strength model |
| Complex LaunchAgent daemon | Simple post-session processor with file locks + circuit breakers | claude-mem 157-zombie incident |
| Inject recollections at every PreToolUse | Inject 3-5 at SessionStart ONLY, beginning of context | Lost-in-middle research, context rot studies |
| General-purpose embeddings | Code-specific embedding model (Qodo-Embed-1, Codestral) | Research: general embeddings fail on code |
| Passive background consolidation only | Hybrid: background capture + agent self-editing via tool calls | 2025 consensus: agent-controlled memory via tool calls |

---

## The Revised Architecture: "Engram Lite"

### Design Principle: Build the 90% solution, measure, then add complexity only where proven needed.

```
WHAT WE BUILD                           WHAT WE DEFER
────────────────────────────────────────────────────────
Auto-capture every transcript      │  Association graph
Simple importance (binary: high/   │  Spreading activation
  normal, not 1-10 scoring)        │  Reflection engine
Episodic store (SQLite + FTS5 +    │  Complex importance scoring
  code-specific embeddings)        │  Continuous PreToolUse injection
Semantic store (MEMORY.md)         │  Narrative memory
Session-start recollection (top 5) │  Ebbinghaus decay curve
Category-aware persistence         │
Agent self-editing (tool calls)    │
Background capture worker (simple) │
Hybrid BM25 + vector retrieval     │
```

### Core Components (5, not 12)

**1. Transcript Processor** (background, post-session)
- Triggered on session end (Stop hook or file watcher)
- Single LLM call: extract key facts, decisions, and entities
- Binary importance: HIGH (architectural decisions, preferences, conventions) or NORMAL
- Store as episodic entry in SQLite with code-specific embedding
- No complex daemon — simple script with file lock

**2. Memory Store** (already mostly built)
- SQLite + FTS5 + code-specific embeddings (replace text-embedding-3-small)
- Episodic entries: session_id, timestamp, project, summary, importance, entities, embedding
- Semantic entries: MEMORY.md (manually curated + auto-graduated from episodes)
- Category-aware persistence: HIGH importance memories never decay. NORMAL memories decay by usage frequency.

**3. Retrieval Engine** (enhance existing)
- Hybrid BM25 + vector (already have this)
- Retrieval scoring: `score = 0.5 × relevance + 0.3 × recency + 0.2 × access_frequency`
- No importance weight in retrieval (unreliable). Instead, HIGH memories get a base activation floor.
- Code-specific embeddings for better clustering of programming content

**4. Recollection Injector** (SessionStart only)
- Inject top 5 recollections at session start, placed at BEGINNING of context
- Brief cue format: 1-2 sentence summary + expand link
- NO PreToolUse injection (avoids context rot)
- Agent can call memory_recall() on-demand if it wants more

**5. Agent Memory Tools** (enhance existing MCP)
- memory_save (already exists) — agent explicitly saves important info
- memory_search (already exists) — agent searches when needed
- memory_recall(query) — NEW: returns top-5 brief cues, agent can expand any
- memory_expand(id) — NEW: returns full episode content
- The agent decides what to save and when to search — not a passive system

### What This Preserves from the Original Vision

The user's core idea — **"a worker that captures everything, and a recollection system where Claude gets memory cues and can choose to expand them"** — is FULLY preserved. We're just:
1. Making the worker simpler and more robust
2. Limiting recollection injection to prevent context rot
3. Dropping components that don't earn their complexity
4. Adding agent self-editing (the 2025 best practice we missed)

---

## Production Lessons Applied

| Lesson From | What We Learned | How We Apply It |
|-------------|----------------|-----------------|
| Mem0 | Graph adds only 2% accuracy | Skip association graph |
| Zep | Ingestion costs 600k tokens | Single LLM call per session, not continuous |
| Letta | Self-editing memory adds latency | Async — agent tools don't block |
| Letta | Sleep-time agents | Our background processor IS the sleep-time agent |
| claude-mem | 157 zombies, 8.4GB RAM | File locks, PID detection, circuit breakers |
| Research | Context rot is real | Hard cap 5 recollections, beginning of context only |
| Research | Embeddings fail on code | Code-specific embedding model |
| Bjork | Storage vs retrieval strength | Category-aware persistence, not time decay |

---

## Open Questions

1. Which code-specific embedding model? (Qodo-Embed-1, Codestral Embed, or GitHub's model)
2. What LLM for transcript processing? (GPT-4.1-nano at $0.007/session or Gemini free tier)
3. Exact trigger for background processor — Stop hook vs file watcher vs both?
4. How to handle episodic→semantic graduation? (automatic after N similar episodes, or manual?)
5. What's the right deduplication strategy? (LLM-based is unreliable per Mem0 experience)
