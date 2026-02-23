# Research: Human-Like Memory Architecture for Claude Code

**Date:** 2026-02-23
**Question:** How can we give Claude Code real human-like memory — with a background consolidation worker and a recollection system where the agent receives brief memory cues and can choose to expand them, just like human recall?

---

## Part 1: How Human Memory Actually Works

### The Three-Stage Pipeline

Human memory is NOT a recording device. It's an active, reconstructive, distributed system:

1. **Encoding** — Sensory input passes through attention filters. Only what receives focused attention enters working memory. Deep, meaningful processing (semantic encoding) creates far stronger traces than shallow/rote repetition (Craik & Lockhart, 1972). Prior knowledge schemas accelerate encoding of schema-consistent information.

2. **Consolidation** — Two timescales:
   - *Synaptic* (minutes→hours): LTP strengthens connections. Requires protein synthesis.
   - *Systems* (days→weeks): Hippocampus replays memories during sleep (sharp-wave ripples coupled with cortical sleep spindles), gradually transferring traces to neocortex. Schema-consistent memories consolidate in days; novel ones take weeks (Tse et al., 2007).

3. **Retrieval** — Memories are *reconstructed*, not replayed. Partial cues trigger pattern completion in hippocampal CA3. Spreading activation primes related concepts. Context at retrieval must overlap with encoding context (Tulving's encoding specificity).

### Memory Types (Critical for System Design)

| Type | What | Brain Region | Duration | Analog in Our System |
|------|------|-------------|----------|---------------------|
| **Working Memory** | Active manipulation buffer (4±1 items) | Prefrontal cortex | Seconds | LLM context window |
| **Episodic** | Autobiographical events with time/place | Hippocampus → neocortex | Days→lifetime | Session transcripts, daily logs |
| **Semantic** | Facts stripped of episode context | Distributed neocortex | Stable | MEMORY.md, knowledge base |
| **Procedural** | Skills, habits, patterns | Basal ganglia, cerebellum | Very stable | Learned conventions, CLAUDE.md |

### Key Mechanisms to Replicate

**1. Hippocampal Indexing** — The hippocampus doesn't store full memories. It stores *pointers* (indices) to distributed cortical representations. When activated, the index reinstates the full pattern. → *Store lightweight summaries that point to full content.*

**2. Spreading Activation** — Activating one concept primes related concepts through weighted associations (Collins & Loftus, 1975). Activation decays with distance. → *Memory retrieval should surface related memories, not just exact matches.*

**3. Complementary Learning Systems** (McClelland et al., 1995) — Fast learning (hippocampus) for new episodes + slow integration (neocortex) for stable knowledge. Interleaved replay prevents catastrophic interference. → *Rapid capture of everything + slow background consolidation into structured knowledge.*

**4. Sleep Consolidation** — During NREM sleep, the brain replays and compresses experiences, extracting gist and integrating with existing schemas. → *Background worker that processes raw transcripts into structured, consolidated memories.*

**5. Emotional Tagging** — Amygdala tags emotionally significant events, enhancing hippocampal encoding. Important events get preferential consolidation. → *Importance scoring that weights memories by significance, not just recency.*

**6. Forgetting as Feature** — Ebbinghaus curve: ~50% forgotten within 1 hour, ~90% within a week. But spaced retrieval resets the curve. Bjork's "New Theory of Disuse": storage strength vs. retrieval strength are separate. → *Temporal decay on retrieval strength, but high-importance memories resist decay.*

**7. Tip-of-the-Tongue → Full Recall** — Partial activation below retrieval threshold produces feeling-of-knowing. Additional cues (first letter, context) push activation above threshold for full recall. → *Return brief cues first; agent chooses to expand specific memories on demand.*

---

## Part 2: Computational Architectures That Map to Biology

### The Generative Agents Model (Park et al., 2023) — Most Directly Relevant

Stanford/Google's 25-agent simulation. Three components:

**Memory Stream:** Complete record of experiences in natural language. Each entry: content, timestamp, last_accessed, importance_score.

**Retrieval Function:**
```
score = α_recency × recency + α_importance × importance + α_relevance × relevance
```
- Recency: exponential decay on time since last access
- Importance: LLM-assigned score (distinguishes mundane from critical)
- Relevance: cosine similarity between memory embedding and current query
- All normalized to [0,1]

**Reflection:** Triggered when cumulative importance of recent events exceeds threshold. LLM generates high-level insights from clusters of memories. Reflections are stored back in the stream and can be reflected on recursively → hierarchical abstraction.

### ACT-R's Activation-Based Retrieval — The Math We Need

Base-level activation: `B_i = ln(Σ t_j^(-d))` where t_j = time since jth access, d ≈ 0.5
- Produces power-law forgetting (matches Ebbinghaus)
- Memories accessed more frequently AND more recently have higher activation

Spreading activation: Currently active concepts boost activation of associated memories through weighted links.

Partial matching: Approximate matches are allowed with a mismatch penalty. → *Fuzzy retrieval, not just exact matching.*

### MemGPT (Packer et al., 2023) — LLM as Memory Manager

Treats the LLM like an OS with RAM (context window) and disk (external storage):
- **Main context** = system prompt + working facts + recent messages
- **Archival memory** = persistent database
- LLM emits function calls to manage its own memory: `store()`, `retrieve()`, `summarize()`, `update()`
- Paging: evicts at 70% context occupancy, summarizes evicted messages
- **Strategic forgetting**: summarization + targeted deletion prevents unbounded growth

### Hybrid Retrieval (What Actually Works for Search)

Pure vector search misses exact names/identifiers. Pure BM25 misses semantic relationships.

**Best practice:** BM25 + vector + optional reranker
- BM25 recall ~0.72 → hybrid recall ~0.91
- Reciprocal Rank Fusion merges ranked lists
- Cross-encoder reranker as final precision pass

### Spreading Activation Over Knowledge Graphs

Algorithm:
```
1. Set source nodes (query concepts) to activation 1.0
2. For each active node above firing threshold:
   Spread activation to neighbors: A[j] += A[i] × W[i,j] × decay
3. Repeat for 2-3 hops
4. Return nodes with highest activation
```
- 2024 research: up to 39% improvement over naive RAG for multi-hop questions
- Equivalent to how human associative memory works

### The Two-Stage Recollection Pattern

All modern systems converge on this:
1. **Stage 1 (Broad recall):** Return many candidates with brief summaries/cues
2. **Stage 2 (Focused retrieval):** Expand selected memories to full content on demand

This prevents context flooding while maintaining access to the full memory store.

---

## Part 3: Current System Analysis

### What We Have (claude-memory)

| Component | What It Does | Biological Analog |
|-----------|-------------|-------------------|
| Session transcripts (.jsonl) | Raw experience recording | Sensory buffer / hippocampal trace |
| MEMORY.md | Stable facts/preferences | Semantic memory (neocortex) |
| Daily logs (YYYY-MM-DD.md) | Session summaries by day | Episodic memory index |
| memory_search (BM25 + vector) | Cue-based retrieval | Pattern completion |
| memory_save | Explicit encoding | Deliberate memorization |
| Pre-compact flush | Context-pressure-triggered save | Emergency consolidation |
| Stop hook | End-of-session summary | Sleep consolidation (partial) |
| SQLite + FTS5 + embeddings | Storage and indexing | Synaptic weight matrix |
| Temporal decay (30-day half-life) | Forgetting curve | Ebbinghaus decay |

### What's Missing (The Gaps)

| Gap | Biological Equivalent | Impact |
|-----|----------------------|--------|
| **No automatic capture** | Like a brain that only remembers what you consciously choose to memorize | Massive holes — VibeTunnel work lost entirely |
| **No importance scoring** | Like treating grocery lists and wedding vows equally | All memories weighted same, no salience |
| **No spreading activation** | Like a library with no cross-references | Search only finds direct matches |
| **No consolidation worker** | Like never sleeping — no offline processing | Raw transcripts never compressed into knowledge |
| **No recollection system** | Like having a filing cabinet but no associative recall | Agent must explicitly search, never gets "reminded" |
| **No episodic→semantic graduation** | Like remembering every detail of every day forever | No abstraction from episodes to general knowledge |
| **No reflection/synthesis** | Like experiencing without learning patterns | No higher-order insights from clusters of memories |
| **Single retrieval mode** | Like only having one way to remember things | No progressive disclosure (cue → full recall) |

---

## Part 4: Proposed Architecture — "Engram"

### Design Philosophy

Map each biological mechanism to a computational component:

```
BIOLOGICAL                          COMPUTATIONAL
─────────────────────────────────────────────────────────
Sensory input                   →   Raw session transcripts (.jsonl)
Attention filter                →   Transcript processor (extract meaningful content)
Working memory                  →   LLM context window
Hippocampal fast encoding       →   Immediate capture (every session, automatic)
Hippocampal index               →   Lightweight memory entries (summary + pointers)
Sleep consolidation             →   Background worker (periodic offline processing)
Systems consolidation           →   Episodic → semantic graduation over time
Spreading activation            →   Association graph + weighted traversal
Pattern completion              →   Cue → candidate → expansion retrieval
Emotional tagging               →   Importance scoring (LLM-assigned salience)
Ebbinghaus forgetting           →   Activation decay (recency × frequency × importance)
Schemas                         →   MEMORY.md knowledge structures
Reflection                      →   Periodic synthesis of patterns from clusters
```

### Memory Types in the System

**1. Episodic Store** (hippocampus analog)
- Every session automatically captured as an episode
- Fields: session_id, timestamp, project, summary, key_entities, importance_score, full_content_ref
- Stored in SQLite with embeddings
- Decays over time unless accessed or high-importance

**2. Semantic Store** (neocortex analog)
- Stable facts, preferences, decisions, architecture knowledge
- Graduated from repeated episodic patterns via consolidation
- MEMORY.md files + structured knowledge entries
- Immune to temporal decay (or very slow decay)

**3. Association Graph** (hippocampal-cortical connections)
- Weighted edges between memory entries based on:
  - Co-occurrence in same session
  - Semantic similarity (embedding cosine)
  - Explicit references
  - Temporal proximity
- Enables spreading activation retrieval

**4. Working Context** (prefrontal cortex analog)
- Current session's injected context (what session-start provides)
- Recent recollections that the agent chose to expand
- Decays within the session (evicted at compaction)

### The Background Consolidation Worker

Runs as a LaunchAgent/daemon, triggered by session end or periodically:

```
1. CAPTURE — Parse new session transcripts
   - Extract user+assistant turns from JSONL
   - Identify: decisions made, problems solved, preferences expressed,
     architecture discussed, bugs found, tools/patterns used
   - Assign importance scores (LLM: 1-10 scale)

2. ENCODE — Create episodic memory entries
   - Generate summary (2-3 sentences)
   - Extract key entities (projects, files, concepts)
   - Generate embedding for semantic search
   - Store full content reference (pointer to JSONL)

3. ASSOCIATE — Build/update association graph
   - Link new episodes to existing memories by:
     - Semantic similarity (cosine > threshold)
     - Shared entities (same project, same file, same concept)
     - Temporal proximity (same day/week)
   - Weight edges by association strength

4. CONSOLIDATE — Periodic (daily/weekly)
   - Identify episodic clusters (multiple sessions on same topic)
   - Synthesize into semantic entries (general knowledge)
   - Update MEMORY.md with new stable knowledge
   - Compress old episodes into summaries
   - Decay/archive low-importance, old, unaccessed memories

5. REFLECT — Periodic (triggered by importance accumulation)
   - Take recent high-importance memories
   - Generate higher-level insights
   - Store reflections as new semantic memories
   - Link reflections to source episodes
```

### The Recollection System

When Claude starts a session or works on a task, the system provides **recollections** — brief memory cues injected into context:

**Injection points:**
- **SessionStart**: Inject top-k recollections based on project context + recent activity
- **PreToolUse**: When Claude is about to act, inject relevant recollections based on current conversation content
- **On-demand**: Claude calls `memory_recall(query)` to get recollections for a specific topic

**Recollection format (the "cue"):**
```
💭 Recollection: [2 days ago] Fixed Safari keyboard bug in VibeTunnel — scrolling
   up triggers keyboard open. Root cause was viewport resize handler.
   [importance: 8/10] [expand: memory_get("episode:abc123")]
```

**Expansion (the "full recall"):**
When Claude sees a recollection and wants more context, it calls `memory_expand(id)` to get:
- Full episode content
- Associated memories (spreading activation, 2 hops)
- Related reflections/insights
- Timeline of related episodes

**Retrieval scoring (adapted from Generative Agents):**
```
score = w_recency × recency(t) + w_importance × importance + w_relevance × relevance(query)

where:
  recency(t) = exp(-λ × days_since_last_access)  // Ebbinghaus-inspired
  importance = LLM-assigned [0,1]                  // Emotional tagging analog
  relevance  = cosine_sim(query_embedding, memory_embedding)  // Pattern matching

  w_recency    = 0.3
  w_importance = 0.3
  w_relevance  = 0.4
```

### Data Flow

```
SESSION TRANSCRIPT (.jsonl)
         │
         ▼
┌─────────────────────┐
│  CONSOLIDATION      │  (Background worker — LaunchAgent)
│  WORKER             │
│                     │
│  1. Parse & extract │
│  2. Score importance│
│  3. Create episodes │
│  4. Build assoc.    │
│  5. Consolidate     │
│  6. Reflect         │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  MEMORY STORE       │
│                     │
│  ┌──────────────┐   │
│  │ Episodic DB  │   │  (SQLite: episodes, embeddings, importance, timestamps)
│  └──────────────┘   │
│  ┌──────────────┐   │
│  │ Semantic DB  │   │  (MEMORY.md + structured knowledge entries)
│  └──────────────┘   │
│  ┌──────────────┐   │
│  │ Assoc Graph  │   │  (Weighted edges between memory entries)
│  └──────────────┘   │
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│  RECOLLECTION       │  (Hooks: SessionStart, PreToolUse, on-demand)
│  ENGINE             │
│                     │
│  Query → Score →    │
│  Top-k cues →       │
│  Optional expand    │
└─────────────────────┘
         │
         ▼
    CLAUDE'S CONTEXT
    (Working Memory)
```

---

## Key Insights

1. **The biggest gap is automatic capture.** Human memory doesn't require conscious effort to record experiences — the hippocampus does it automatically. Our system currently requires Claude to explicitly call memory_save, which means important work falls through the cracks entirely.

2. **Consolidation is the magic.** The brain doesn't store raw sensory data forever. It compresses, abstracts, and integrates during sleep. A background consolidation worker that processes raw transcripts into structured knowledge is the single most impactful addition.

3. **Recollection, not search, is how humans remember.** Humans don't consciously query their memory — related memories surface automatically through spreading activation. The system should push relevant cues to Claude proactively, not wait for explicit search.

4. **Two-stage retrieval prevents context flooding.** Brief cues first (like tip-of-the-tongue), full expansion on demand. This respects the LLM's limited context window while maintaining access to the full memory store.

5. **Importance scoring is essential.** Without it, a grocery list has the same weight as an architecture decision. LLM-assigned importance scores (analog of emotional tagging) ensure critical memories resist forgetting.

6. **The Generative Agents retrieval formula works.** `score = recency + importance + relevance` with exponential decay is the computational equivalent of ACT-R's base-level activation + spreading activation. It's been validated in practice.

7. **Episodic→semantic graduation closes the abstraction gap.** Raw sessions should eventually compress into general knowledge ("user prefers bun over npm") rather than persisting as individual episodes forever.

## Open Questions

- What LLM should power the consolidation worker? (GPT-4.1-nano at $0.65/month vs. Gemini free tier)
- How aggressively should the association graph link memories? (too few links = no spreading activation; too many = noise)
- What's the right importance threshold for consolidation into MEMORY.md?
- Should reflections be automatic (Generative Agents: triggered by importance accumulation) or periodic (daily)?
- How to handle conflicting memories (user changed preference)?
- What's the optimal number of recollections to inject without cluttering context?
