import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { packEmbedding, cosineSimilarity } from '../mcp/embeddings.js';
import type { EmbeddingProvider } from '../mcp/providers.js';

// ---------------------------------------------------------------------------
// Configurable topic-change threshold
// ---------------------------------------------------------------------------

const DEFAULT_TOPIC_THRESHOLD = 0.85;
const TOPIC_CHANGE_THRESHOLD = (() => {
  const val = process.env.ENGRAM_TOPIC_THRESHOLD;
  if (!val) return DEFAULT_TOPIC_THRESHOLD;
  const parsed = parseFloat(val);
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    console.error(`[recollection] Invalid ENGRAM_TOPIC_THRESHOLD="${val}" — using ${DEFAULT_TOPIC_THRESHOLD}`);
    return DEFAULT_TOPIC_THRESHOLD;
  }
  return parsed;
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryBite {
  id: string;
  bite: string;
  date: number;
  importance: string;
}

interface RecollectionFile {
  messageUuid: string;
  timestamp: number;
  bites: MemoryBite[];
}

interface EpisodeRow {
  id: string;
  summary: string;
  importance: string;
  embedding: Buffer | null;
  created_at: number;
  accessed_at: number;
  access_count: number;
  rowid: number;
}

interface BM25Row {
  rowid: number;
  score: number;
}

// ---------------------------------------------------------------------------
// Recollection directory
// ---------------------------------------------------------------------------

const RECOLLECTIONS_DIR = path.join(os.homedir(), '.claude-memory', 'recollections');

// ---------------------------------------------------------------------------
// Write pre-computed recollections for a session
// ---------------------------------------------------------------------------

export async function writeRecollections(
  sessionId: string,
  userMessage: string,
  userMessageUuid: string,
  projectName: string | null,
  previousEmbedding: Float32Array | null,
  embedProvider: EmbeddingProvider,
  db: Database,
  force?: boolean,
): Promise<{ embedding: Float32Array }> {
  // 1. Embed user message locally (~5ms)
  // Truncate to 6000 chars (~1500 tokens) — nomic-embed-text has 8192 token limit
  // and long messages don't produce better embeddings for topic gating
  const truncated = userMessage.length > 6000 ? userMessage.slice(0, 6000) : userMessage;
  let currentEmbedding: Float32Array | null = null;
  try {
    const embeddings = await embedProvider.embed([truncated]);
    currentEmbedding = embeddings[0] ?? null;
  } catch {
    currentEmbedding = null; // NOT a zero vector — would pollute cosine similarity
  }
  if (!currentEmbedding) {
    console.error('[recollection] Failed to embed user message — skipping topic gate');
    // Can't compare topics — treat as topic change (safe default: always recollect)
    // Return previous embedding so we don't replace a good one with null
    return { embedding: previousEmbedding ?? new Float32Array(768) };
  }

  // 2. Topic-change gate: cosine sim > 0.85 with previous = SKIP
  //    Bypassed when force=true (e.g. refreshRecollection after extraction)
  if (!force && previousEmbedding && previousEmbedding.some(v => v !== 0)) {
    const prevBlob = packEmbedding(previousEmbedding);
    const currBlob = packEmbedding(currentEmbedding);
    const sim = cosineSimilarity(prevBlob, currBlob);
    if (sim > TOPIC_CHANGE_THRESHOLD) {
      // Same topic — keep previous recollection file as-is
      return { embedding: currentEmbedding };
    }
  }

  // 3. Search episodes with hybrid BM25 + vector
  const queryBlob = packEmbedding(currentEmbedding);

  // BM25 search on episodes_fts
  const FTS5_RESERVED = new Set(['OR', 'AND', 'NOT', 'NEAR']);
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
    'how', 'what', 'when', 'where', 'why', 'which', 'who', 'whom',
    'that', 'this', 'it', 'its', 'in', 'on', 'at', 'to', 'for', 'of',
    'with', 'by', 'from', 'as', 'but', 'if', 'so', 'than', 'then',
    'be', 'been', 'being', 'have', 'has', 'had', 'will', 'would',
    'could', 'should', 'may', 'can', 'just', 'about', 'also', 'very',
    'my', 'your', 'we', 'they', 'he', 'she', 'me', 'us', 'them',
  ]);
  const ftsQuery = userMessage
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !FTS5_RESERVED.has(t.toUpperCase())) // strip FTS5 reserved words
    .filter(t => !STOP_WORDS.has(t.toLowerCase()))    // strip common question/stop words
    .slice(0, 20) // limit terms
    .join(' OR ');

  let bm25Rows: BM25Row[] = [];
  if (ftsQuery.length > 0) {
    try {
      bm25Rows = db.prepare(
        'SELECT rowid, bm25(episodes_fts) as score FROM episodes_fts WHERE episodes_fts MATCH ? LIMIT 50',
      ).all(ftsQuery) as BM25Row[];
    } catch {
      // FTS match can fail on unusual input — fall back to vector-only
    }
  }

  // Build a set of candidate rowids from BM25
  const bm25Map = new Map<number, number>();
  for (const row of bm25Rows) {
    bm25Map.set(row.rowid, row.score);
  }

  // Fetch recent episodes across ALL projects — recollections should surface
  // the most relevant memories regardless of project boundaries
  const vectorPool: EpisodeRow[] = db.prepare(
    `SELECT rowid, id, summary, importance, embedding, created_at, accessed_at, access_count
     FROM episodes
     WHERE embedding IS NOT NULL
     ORDER BY accessed_at DESC
     LIMIT 200`,
  ).all() as EpisodeRow[];

  if (vectorPool.length === 0) {
    // No episodes yet — write empty recollection
    writeRecollectionFile(sessionId, userMessageUuid, []);
    return { embedding: currentEmbedding };
  }

  // Collect rowids from vector pool into a Set for fast lookup
  const vectorPoolRowids = new Set<number>(vectorPool.map(e => e.rowid));

  // Find BM25 hits not already in the vector pool — these are old/rare episodes
  // that keyword-match but weren't in the 200 most-recently-accessed
  const missingRowids = Array.from(bm25Map.keys()).filter(rid => !vectorPoolRowids.has(rid));

  let bm25Misses: EpisodeRow[] = [];
  if (missingRowids.length > 0) {
    const placeholders = missingRowids.map(() => '?').join(',');
    bm25Misses = db.prepare(
      `SELECT rowid, id, summary, importance, embedding, created_at, accessed_at, access_count
       FROM episodes
       WHERE rowid IN (${placeholders}) AND embedding IS NOT NULL`,
    ).all(...missingRowids) as EpisodeRow[];
  }

  // Unified candidate set: vector pool + BM25 misses (already deduped — misses filtered above)
  const candidates: EpisodeRow[] = [...vectorPool, ...bm25Misses];

  const now = Date.now();

  // 4. RRF scoring: Reciprocal Rank Fusion across BM25, vector, recency, access frequency
  //    K=60 (Cormack et al. 2009 standard), weights are relative multipliers
  const K = 60;
  const W_BM25 = 0.4;    // keyword relevance — calibrated to ~0.4:1.0 vs vector, matching old hybrid ratio (BM25 was ~15% vs vector ~35%)
  const W_VECTOR = 1.0;  // semantic relevance
  const W_RECENCY = 0.6; // temporal signal
  const W_ACCESS = 0.4;  // usage frequency signal

  // Pre-compute pass: O(N) — compute vectorSim and bm25Score once per candidate
  // IMPORTANT: pre-compute before sort to avoid O(N log N) cosineSimilarity calls inside comparators
  interface CandidateScores {
    vectorSim: number;
    bm25Score: number | null; // null = no BM25 hit
  }

  const precomputed = new Map<number, CandidateScores>();
  for (const ep of candidates) {
    const vectorSim = ep.embedding !== null
      ? cosineSimilarity(queryBlob, ep.embedding as Buffer)
      : 0;
    const bm25Score = bm25Map.has(ep.rowid) ? bm25Map.get(ep.rowid)! : null;
    precomputed.set(ep.rowid, { vectorSim, bm25Score });
  }

  // Build 4 rank lists using pre-computed values — 1-based dense ranking (ties share the same rank)
  // BM25 rank list: only candidates with BM25 hits, ascending score (more negative = better in FTS5)
  const bm25Candidates = candidates.filter(ep => precomputed.get(ep.rowid)!.bm25Score !== null);
  bm25Candidates.sort((a, b) => precomputed.get(a.rowid)!.bm25Score! - precomputed.get(b.rowid)!.bm25Score!);
  const bm25RankMap = new Map<number, number>();
  { let rank = 1;
    for (let i = 0; i < bm25Candidates.length; i++) {
      if (i > 0 && precomputed.get(bm25Candidates[i].rowid)!.bm25Score! === precomputed.get(bm25Candidates[i - 1].rowid)!.bm25Score!) {
        bm25RankMap.set(bm25Candidates[i].rowid, bm25RankMap.get(bm25Candidates[i - 1].rowid)!);
      } else {
        bm25RankMap.set(bm25Candidates[i].rowid, rank);
      }
      rank++;
    }
  }

  // Vector rank list: all candidates, descending vectorSim (rank 1 = most similar)
  const vectorSorted = [...candidates].sort(
    (a, b) => precomputed.get(b.rowid)!.vectorSim - precomputed.get(a.rowid)!.vectorSim,
  );
  const vectorRankMap = new Map<number, number>();
  { let rank = 1;
    for (let i = 0; i < vectorSorted.length; i++) {
      if (i > 0 && precomputed.get(vectorSorted[i].rowid)!.vectorSim === precomputed.get(vectorSorted[i - 1].rowid)!.vectorSim) {
        vectorRankMap.set(vectorSorted[i].rowid, vectorRankMap.get(vectorSorted[i - 1].rowid)!);
      } else {
        vectorRankMap.set(vectorSorted[i].rowid, rank);
      }
      rank++;
    }
  }

  // Recency rank list: all candidates, descending created_at (rank 1 = most recent)
  const recencySorted = [...candidates].sort((a, b) => b.created_at - a.created_at);
  const recencyRankMap = new Map<number, number>();
  { let rank = 1;
    for (let i = 0; i < recencySorted.length; i++) {
      if (i > 0 && recencySorted[i].created_at === recencySorted[i - 1].created_at) {
        recencyRankMap.set(recencySorted[i].rowid, recencyRankMap.get(recencySorted[i - 1].rowid)!);
      } else {
        recencyRankMap.set(recencySorted[i].rowid, rank);
      }
      rank++;
    }
  }

  // Access frequency rank list: all candidates, descending access_count (rank 1 = most accessed)
  const accessSorted = [...candidates].sort((a, b) => b.access_count - a.access_count);
  const accessRankMap = new Map<number, number>();
  { let rank = 1;
    for (let i = 0; i < accessSorted.length; i++) {
      if (i > 0 && accessSorted[i].access_count === accessSorted[i - 1].access_count) {
        accessRankMap.set(accessSorted[i].rowid, accessRankMap.get(accessSorted[i - 1].rowid)!);
      } else {
        accessRankMap.set(accessSorted[i].rowid, rank);
      }
      rank++;
    }
  }

  // RRF fusion: compute final score per candidate
  interface ScoredEpisode {
    episode: EpisodeRow;
    finalScore: number;
  }

  const scored: ScoredEpisode[] = [];
  const hasBm25Hits = bm25Map.size > 0; // skip BM25 term entirely if no FTS hits

  for (const ep of candidates) {
    let rrfScore = 0;

    // BM25 contribution: only if this candidate has a BM25 hit AND there were FTS hits
    if (hasBm25Hits) {
      const bm25Rank = bm25RankMap.get(ep.rowid);
      if (bm25Rank !== undefined) {
        rrfScore += W_BM25 / (K + bm25Rank);
      }
      // Candidates without a BM25 hit contribute 0 to BM25 term (not worst-rank)
    }

    // Vector, recency, access always contribute
    rrfScore += W_VECTOR / (K + vectorRankMap.get(ep.rowid)!);
    rrfScore += W_RECENCY / (K + recencyRankMap.get(ep.rowid)!);
    rrfScore += W_ACCESS / (K + accessRankMap.get(ep.rowid)!);

    // High-importance boost: additive bonus ~equivalent to 10 rank positions (~0.0023 at K=60)
    if (ep.importance === 'high') {
      rrfScore += 1.0 / (K + 1) - 1.0 / (K + 11);
    }

    scored.push({ episode: ep, finalScore: rrfScore });
  }

  // Sort by final score descending, take top 3
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const top3raw = scored.slice(0, 3);

  // Filter out results with low vector similarity — prevents surfacing irrelevant
  // keyword-only matches when no episodes are semantically related to the query.
  // Threshold 0.25 filters clearly unrelated content while keeping tangential matches.
  const MIN_VECTOR_SIM = 0.25;
  const top3 = top3raw.filter(s => {
    const scores = precomputed.get(s.episode.rowid);
    return scores ? scores.vectorSim >= MIN_VECTOR_SIM : false;
  });

  // Format as memory bites
  const bites: MemoryBite[] = top3.map(s => ({
    id: s.episode.id,
    bite: `[Memory flash: ${s.episode.summary}]`,
    date: s.episode.created_at,
    importance: s.episode.importance,
  }));

  // 5. Atomic write to recollection file
  writeRecollectionFile(sessionId, userMessageUuid, bites);

  // Update accessed_at for freshness tracking (but NOT access_count —
  // reserve access_count increments for agent-initiated recall/expand only)
  const updateStmt = db.prepare(
    'UPDATE episodes SET accessed_at = ? WHERE id = ?',
  );
  for (const s of top3) {
    updateStmt.run(now, s.episode.id);
  }

  return { embedding: currentEmbedding };
}

// ---------------------------------------------------------------------------
// Eager refresh — called by daemon after an extraction cycle
// ---------------------------------------------------------------------------

/**
 * Eagerly refresh recollection for a session — called by daemon after extraction.
 * Re-runs the recollection pipeline with the session's last user message.
 */
export async function refreshRecollection(
  sessionId: string,
  lastUserMessage: string,
  lastMessageUuid: string,
  projectName: string | null,
  previousEmbedding: Float32Array | null,
  embedProvider: EmbeddingProvider,
  db: Database,
): Promise<{ embedding: Float32Array }> {
  // Re-use the main writeRecollections function — force=true bypasses topic gate
  return writeRecollections(
    sessionId,
    lastUserMessage,
    lastMessageUuid,
    projectName,
    previousEmbedding,
    embedProvider,
    db,
    true, // force: skip topic-change gate since we just extracted new episodes
  );
}

// ---------------------------------------------------------------------------
// Atomic file write
// ---------------------------------------------------------------------------

function writeRecollectionFile(
  sessionId: string,
  messageUuid: string,
  bites: MemoryBite[],
): void {
  try {
    fs.mkdirSync(RECOLLECTIONS_DIR, { recursive: true });

    const data: RecollectionFile = {
      messageUuid,
      timestamp: Date.now(),
      bites,
    };

    const targetPath = path.join(RECOLLECTIONS_DIR, `${sessionId}.json`);
    const tmpPath = targetPath + `.tmp.${process.pid}`;

    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    console.error(`[recollection] Failed to write recollection file: ${(err as Error).message}`);
    // Don't rethrow — let the caller continue with stale recollection
  }
}
