import { Database } from 'bun:sqlite';
import { cosineSimilarity } from './embeddings.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  path: string;
  layer: 'global' | 'project';
  project: string | null;
  startLine: number;
  endLine: number;
  text: string;
  score: number; // final score after temporal decay
}

interface BM25Row {
  rowid: number;
  score: number; // raw bm25 score (negative, more negative = better)
}

interface ChunkRow {
  id: string;
  path: string;
  layer: 'global' | 'project';
  project: string | null;
  start_line: number;
  end_line: number;
  text: string;
  embedding: Buffer | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Evergreen detection — match date only on basename
// ---------------------------------------------------------------------------

function isEvergreen(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  return basename.endsWith('MEMORY.md') || !/^\d{4}-\d{2}-\d{2}/.test(basename);
}

// ---------------------------------------------------------------------------
// Hybrid BM25 + vector search with temporal decay
// ---------------------------------------------------------------------------

export function search(
  db: Database,
  queryEmbedding: Buffer,
  query: string,
  limit: number = 10,
  project?: string,
): SearchResult[] {
  const candidateCount = limit * 3;

  // 1. BM25 via FTS5
  //    Split into individual terms (FTS5 implicit AND) — phrase quoting is too strict
  //    and returns 0 results for most natural-language queries.
  const ftsQuery = query
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, ' ') // strip FTS5 special chars
    .split(/\s+/)
    .filter(Boolean)
    .join(' AND ');
  const bm25Rows = db
    .prepare(
      'SELECT rowid, bm25(fts) as score FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?',
    )
    .all(ftsQuery, candidateCount) as BM25Row[];

  if (bm25Rows.length === 0) return [];

  // 2. Fetch full chunk for each BM25 hit, optionally filtering by project
  const chunkStmt = project
    ? db.prepare('SELECT * FROM chunks WHERE rowid = ? AND project = ?')
    : db.prepare('SELECT * FROM chunks WHERE rowid = ?');

  interface ScoredCandidate {
    chunk: ChunkRow;
    rawBM25: number;
    vectorScore: number;
  }

  const candidates: ScoredCandidate[] = [];

  for (const row of bm25Rows) {
    const chunk = (
      project
        ? chunkStmt.get(row.rowid, project)
        : chunkStmt.get(row.rowid)
    ) as ChunkRow | undefined;

    if (!chunk) continue; // filtered out by project, or missing

    // 3. Compute vector score if chunk has an embedding
    let vectorScore = 0;
    if (chunk.embedding) {
      vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
    }

    candidates.push({ chunk, rawBM25: row.score, vectorScore });
  }

  if (candidates.length === 0) return [];

  // 4. Min-max normalise BM25 scores across the result batch
  //    BM25 scores from FTS5 are negative: more negative = better
  //    bm25Min is the most negative value, bm25Max is closest to 0
  const rawBM25Scores = candidates.map((c) => c.rawBM25);
  const bm25Min = Math.min(...rawBM25Scores);
  const bm25Max = Math.max(...rawBM25Scores);

  // Temporal decay constants (30-day half-life)
  const lambda = Math.LN2 / 30;
  const now = Date.now();

  const results: SearchResult[] = candidates.map((c) => {
    // Normalised BM25: 0..1 range (1 = best match)
    const bm25Score =
      (c.rawBM25 - bm25Max) / (bm25Min - bm25Max + 1e-9);

    // 5. Combine: 70% vector + 30% BM25
    const rawScore = 0.7 * c.vectorScore + 0.3 * bm25Score;

    // 6. Temporal decay
    const ageInDays = (now - c.chunk.updated_at) / 86_400_000;
    const decay = isEvergreen(c.chunk.path)
      ? 1.0
      : Math.exp(-lambda * ageInDays);
    const finalScore = rawScore * decay;

    return {
      id: c.chunk.id,
      path: c.chunk.path,
      layer: c.chunk.layer,
      project: c.chunk.project,
      startLine: c.chunk.start_line,
      endLine: c.chunk.end_line,
      text: c.chunk.text,
      score: finalScore,
    };
  });

  // 7. Sort descending by score, return top `limit`
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
