import { cosineSimilarity } from './embeddings.js';
// ---------------------------------------------------------------------------
// Evergreen detection — match date only on basename
// ---------------------------------------------------------------------------
function isEvergreen(filePath) {
    const basename = filePath.split('/').pop() ?? filePath;
    return basename.endsWith('MEMORY.md') || !/^\d{4}-\d{2}-\d{2}/.test(basename);
}
// ---------------------------------------------------------------------------
// MMR re-ranking helpers
// ---------------------------------------------------------------------------
// Jaccard similarity between two strings (tokenized on non-word chars)
function jaccardSim(a, b) {
    const tokA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
    const tokB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
    if (tokA.size === 0 && tokB.size === 0)
        return 1;
    if (tokA.size === 0 || tokB.size === 0)
        return 0;
    let intersection = 0;
    for (const t of tokA)
        if (tokB.has(t))
            intersection++;
    return intersection / (tokA.size + tokB.size - intersection);
}
// MMR re-ranking: lambda=0.7 matches OpenClaw default
// Greedy selection: maximize lambda*relevance - (1-lambda)*maxSimilarityToSelected
function mmrRerank(results, limit, lambda = 0.7) {
    if (results.length === 0)
        return [];
    const selected = [];
    const remaining = [...results];
    while (selected.length < limit && remaining.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;
            const maxSim = selected.length === 0
                ? 0
                : Math.max(...selected.map(s => jaccardSim(remaining[i].text, s.text)));
            const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
            if (mmrScore > bestScore) {
                bestScore = mmrScore;
                bestIdx = i;
            }
        }
        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }
    return selected;
}
// ---------------------------------------------------------------------------
// Hybrid BM25 + vector search with temporal decay
// ---------------------------------------------------------------------------
export function search(db, queryEmbedding, query, limit = 10, project) {
    const candidateCount = limit * 3;
    // 1. BM25 via FTS5
    //    Split into individual terms (FTS5 implicit AND) — phrase quoting is too strict
    //    and returns 0 results for most natural-language queries.
    const FTS5_RESERVED = new Set(['OR', 'AND', 'NOT', 'NEAR']);
    const ftsQuery = query
        .trim()
        .replace(/[^a-zA-Z0-9\s]/g, ' ') // strip FTS5 special chars
        .split(/\s+/)
        .filter(Boolean)
        .filter(t => !FTS5_RESERVED.has(t.toUpperCase())) // strip FTS5 reserved words
        .join(' OR '); // OR union: vector + BM25 scoring handles ranking; AND was too strict for multi-word queries
    let bm25Rows = [];
    if (ftsQuery.length > 0) {
        try {
            bm25Rows = db
                .prepare('SELECT rowid, bm25(fts) as score FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?')
                .all(ftsQuery, candidateCount);
        }
        catch {
            // FTS match failed — fall through to vector fallback
        }
    }
    if (bm25Rows.length === 0) {
        // Vector-only fallback when FTS returns nothing
        const allChunks = (project
            ? db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL AND (project = ? OR project IS NULL) ORDER BY updated_at DESC LIMIT ?').all(project, candidateCount)
            : db.prepare('SELECT * FROM chunks WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?').all(candidateCount));
        if (allChunks.length === 0)
            return [];
        const now = Date.now();
        const lambda = Math.LN2 / 30;
        const vectorResults = allChunks
            .map(chunk => {
            const vectorScore = chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
            const ageInDays = (now - chunk.updated_at) / 86_400_000;
            const decay = isEvergreen(chunk.path) ? 1.0 : Math.exp(-lambda * ageInDays);
            return {
                id: chunk.id,
                path: chunk.path,
                layer: chunk.layer,
                project: chunk.project,
                startLine: chunk.start_line,
                endLine: chunk.end_line,
                text: chunk.text,
                score: vectorScore * decay,
            };
        })
            .sort((a, b) => b.score - a.score);
        return mmrRerank(vectorResults, limit);
    }
    // 2. Fetch full chunk for each BM25 hit, optionally filtering by project
    const chunkStmt = project
        ? db.prepare('SELECT * FROM chunks WHERE rowid = ? AND (project = ? OR project IS NULL)')
        : db.prepare('SELECT * FROM chunks WHERE rowid = ?');
    const candidates = [];
    for (const row of bm25Rows) {
        const chunk = (project
            ? chunkStmt.get(row.rowid, project)
            : chunkStmt.get(row.rowid));
        if (!chunk)
            continue; // filtered out by project, or missing
        // 3. Compute vector score if chunk has an embedding
        let vectorScore = 0;
        if (chunk.embedding) {
            vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
        }
        candidates.push({ chunk, rawBM25: row.score, vectorScore });
    }
    if (candidates.length === 0)
        return [];
    // 4. Min-max normalise BM25 scores across the result batch
    //    BM25 scores from FTS5 are negative: more negative = better
    //    bm25Min is the most negative value, bm25Max is closest to 0
    const rawBM25Scores = candidates.map((c) => c.rawBM25);
    const bm25Min = Math.min(...rawBM25Scores);
    const bm25Max = Math.max(...rawBM25Scores);
    // Temporal decay constants (30-day half-life)
    const lambda = Math.LN2 / 30;
    const now = Date.now();
    const results = candidates.map((c) => {
        // Normalised BM25: 0..1 range (1 = best match)
        const bm25Score = bm25Min === bm25Max
            ? 1.0 // Single hit gets full BM25 score
            : (c.rawBM25 - bm25Max) / (bm25Min - bm25Max);
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
    // 7. Sort descending by score, then MMR re-rank for diversity
    results.sort((a, b) => b.score - a.score);
    return mmrRerank(results, limit);
}
