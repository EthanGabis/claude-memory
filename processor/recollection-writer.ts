import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { packEmbedding, unpackEmbedding, cosineSimilarity } from '../mcp/embeddings.js';
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
): Promise<{ embedding: Float32Array }> {
  // 1. Embed user message locally (~5ms)
  let currentEmbedding: Float32Array | null = null;
  try {
    const embeddings = await embedProvider.embed([userMessage]);
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
  if (previousEmbedding && previousEmbedding.some(v => v !== 0)) {
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
  const ftsQuery = userMessage
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !FTS5_RESERVED.has(t.toUpperCase())) // strip FTS5 reserved words
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

  // Fetch all episodes matching scope filter (for vector search)
  const episodes = db.prepare(
    `SELECT rowid, id, summary, importance, embedding, created_at, accessed_at, access_count
     FROM episodes
     WHERE (scope = 'global' OR project = ?)
     AND embedding IS NOT NULL`,
  ).all(projectName) as EpisodeRow[];

  if (episodes.length === 0) {
    // No episodes yet — write empty recollection
    writeRecollectionFile(sessionId, userMessageUuid, []);
    return { embedding: currentEmbedding };
  }

  // 4. Score each episode: 0.5*relevance + 0.3*recency + 0.2*accessFrequency
  const now = Date.now();
  const maxAge = 30 * 86_400_000; // 30 days for recency normalization

  // Find max access_count for normalization
  const maxAccess = Math.max(1, ...episodes.map(e => e.access_count));

  interface ScoredEpisode {
    episode: EpisodeRow;
    finalScore: number;
  }

  const scored: ScoredEpisode[] = [];

  // Min-max normalize BM25 scores
  const bm25Scores = Array.from(bm25Map.values());
  const bm25Min = bm25Scores.length > 0 ? Math.min(...bm25Scores) : 0;
  const bm25Max = bm25Scores.length > 0 ? Math.max(...bm25Scores) : 0;

  for (const episode of episodes) {
    // Vector similarity
    const vectorSim = cosineSimilarity(queryBlob, episode.embedding as Buffer);

    // BM25 score (normalized) — only episodes with a BM25 hit participate
    let normBm25 = 0;
    if (bm25Map.has(episode.rowid)) {
      const rawBm25 = bm25Map.get(episode.rowid)!;
      if (bm25Min === bm25Max) {
        normBm25 = 1.0; // Single hit gets full BM25 score
      } else {
        normBm25 = (rawBm25 - bm25Max) / (bm25Min - bm25Max);
      }
    }

    // Combined relevance: 70% vector + 30% BM25
    let relevance = 0.7 * vectorSim + 0.3 * normBm25;

    // High-importance floor: minimum relevance of 0.3
    if (episode.importance === 'high' && relevance < 0.3) {
      relevance = 0.3;
    }

    // Recency: exponential decay (30-day half-life)
    const ageMs = now - episode.created_at;
    const recency = Math.exp(-Math.LN2 / 30 * (ageMs / 86_400_000));

    // Access frequency: normalized 0-1
    const accessFreq = episode.access_count / maxAccess;

    // Final score
    const finalScore = 0.5 * relevance + 0.3 * recency + 0.2 * accessFreq;
    scored.push({ episode, finalScore });
  }

  // Sort by final score descending, take top 3
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const top3 = scored.slice(0, 3);

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
