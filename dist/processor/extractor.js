import { randomUUID } from 'node:crypto';
import { packEmbedding, cosineSimilarity } from '../mcp/embeddings.js';
// ---------------------------------------------------------------------------
// LLM Extraction via OpenAI GPT-4.1-nano
// ---------------------------------------------------------------------------
const EXTRACTION_PROMPT = `You are a memory extraction system. Given the previous context summary and new conversation messages, extract the key memories worth remembering long-term.

For each memory, provide:
- summary: 1 sentence (max 40 tokens) — the "memory bite"
- full_content: 2-3 paragraphs of context for later expansion
- entities: array of key names (files, projects, concepts, people)
- importance: "high" if it's an architectural decision, user preference, convention, or critical bug fix. "normal" for everything else.
- scope: "global" if it's a general fact/preference, "project" if specific to this project

Also return an updated rolling summary of the conversation so far (max 200 tokens).

Return JSON only:
{
  "memories": [...],
  "updatedSummary": "..."
}

If there are no memories worth extracting, return {"memories": [], "updatedSummary": "..."}`;
// Singleton OpenAI client — avoids recreating HTTP connection pool on every extraction
let _openaiClient = null;
let _openaiKey = null;
function getOpenAIClient(apiKey) {
    if (_openaiClient && _openaiKey === apiKey)
        return _openaiClient;
    // Dynamic import is module-cached by Bun after first call
    const OpenAI = require('openai').default;
    _openaiClient = new OpenAI({ apiKey });
    _openaiKey = apiKey;
    return _openaiClient;
}
export async function extractMemories(previousSummary, newMessages, projectName, llmApiKey) {
    const client = getOpenAIClient(llmApiKey);
    const userContent = [
        `Previous conversation summary: ${previousSummary || '(new conversation)'}`,
        `Project: ${projectName || '(unknown)'}`,
        '',
        'New messages:',
        ...newMessages.map(m => `[${m.role}]: ${m.content.slice(0, 2000)}`),
    ].join('\n');
    const response = await client.chat.completions.create({
        model: 'gpt-4.1-nano',
        messages: [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2000,
    });
    const raw = response.choices[0]?.message?.content;
    if (!raw) {
        return { memories: [], updatedSummary: previousSummary };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            memories: parsed.memories ?? [],
            updatedSummary: parsed.updatedSummary ?? previousSummary,
        };
    }
    catch {
        console.error('[extractor] Failed to parse LLM response');
        return { memories: [], updatedSummary: previousSummary };
    }
}
/**
 * Fetch all episode rows needed for similarity dedup — call ONCE per extraction batch,
 * then pass the result to each upsertEpisode call.
 */
export function fetchEpisodeSnapshot(db, projectName) {
    return db.prepare(`SELECT id, summary, entities, embedding, access_count
     FROM episodes
     WHERE (scope = 'global' OR project = ?)
     AND embedding IS NOT NULL`).all(projectName);
}
export async function upsertEpisode(candidate, sessionId, projectName, embedProvider, db, existingRows) {
    // Embed the candidate summary for similarity comparison
    const embeddings = await embedProvider.embed([candidate.summary]);
    const candidateVec = embeddings[0];
    if (!candidateVec) {
        console.error('[extractor] Failed to embed candidate — skipping');
        return { action: 'noop' };
    }
    const candidateBlob = packEmbedding(candidateVec);
    // Use pre-fetched snapshot for similarity search (avoids N full-table scans)
    const rows = existingRows;
    let bestMatch = null;
    let bestSim = 0;
    for (const row of rows) {
        if (!row.embedding)
            continue;
        const sim = cosineSimilarity(candidateBlob, row.embedding);
        if (sim > bestSim) {
            bestSim = sim;
            bestMatch = row;
        }
    }
    const now = Date.now();
    if (bestMatch && bestSim > 0.85) {
        // UPDATE existing episode
        db.prepare(`UPDATE episodes
       SET summary = ?, full_content = ?, entities = ?,
           importance = ?, embedding = ?, accessed_at = ?,
           access_count = access_count + 1
       WHERE id = ?`).run(candidate.summary, candidate.full_content, JSON.stringify(candidate.entities), candidate.importance, candidateBlob, now, bestMatch.id);
        return { action: 'update' };
    }
    // ADD new episode
    const id = `ep_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    db.prepare(`INSERT INTO episodes (id, session_id, project, scope, summary, entities, importance, source_type, full_content, embedding, created_at, accessed_at, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, 0)`).run(id, sessionId, candidate.scope === 'project' ? projectName : null, candidate.scope, candidate.summary, JSON.stringify(candidate.entities), candidate.importance, candidate.full_content, candidateBlob, now, now);
    return { action: 'add', id, embedding: candidateBlob };
}
