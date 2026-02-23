import { randomUUID } from 'node:crypto';
import { packEmbedding, cosineSimilarity } from '../mcp/embeddings.js';
import type { EmbeddingProvider } from '../mcp/providers.js';
import type { Database } from 'bun:sqlite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateMemory {
  summary: string;
  full_content: string;
  entities: string[];
  importance: 'high' | 'normal';
  scope: 'global' | 'project';
}

interface ExtractionResult {
  memories: CandidateMemory[];
  updatedSummary: string;
}

interface Message {
  role: string;
  content: string;
}

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

SCOPE RULES:
- Set scope to "project" if the memory is specifically about the current project (PROJECT_NAME).
- Set scope to "global" if:
  - The memory is about the user's preferences, habits, or general knowledge
  - The memory mentions a DIFFERENT project or product by name
  - The memory is about a concept, plan, or idea not tied to the current codebase
  - The current project is a root projects directory (PROJECT_IS_ROOT=true)
- Include mentioned project names, product names, and key concepts in the entities array.

Also return an updated rolling summary of the conversation so far (max 200 tokens).

Return JSON only:
{
  "memories": [...],
  "updatedSummary": "..."
}

If there are no memories worth extracting, return {"memories": [], "updatedSummary": "..."}`;

// Singleton OpenAI client — avoids recreating HTTP connection pool on every extraction
let _openaiClient: any = null;
let _openaiKey: string | null = null;

function getOpenAIClient(apiKey: string) {
  if (_openaiClient && _openaiKey === apiKey) return _openaiClient;
  // Dynamic import is module-cached by Bun after first call
  const OpenAI = require('openai').default;
  _openaiClient = new OpenAI({ apiKey });
  _openaiKey = apiKey;
  return _openaiClient;
}

export async function extractMemories(
  previousSummary: string,
  newMessages: Message[],
  projectName: string | null,
  llmApiKey: string,
  isRoot?: boolean,
): Promise<ExtractionResult> {
  const client = getOpenAIClient(llmApiKey);

  const userContent = [
    `Previous conversation summary: ${previousSummary || '(new conversation)'}`,
    `Project: ${projectName || '(unknown)'}`,
    `PROJECT_IS_ROOT: ${isRoot ? 'true' : 'false'}`,
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
    if (!parsed || !Array.isArray(parsed.memories)) {
      console.error('[extractor] LLM returned invalid shape');
      return { memories: [], updatedSummary: previousSummary };
    }
    // W4: Validate and sanitize each memory item from LLM output
    const validated = parsed.memories.filter((m: any) => {
      if (!m || typeof m !== 'object') return false;
      if (typeof m.summary !== 'string' || !m.summary.trim()) return false;
      if (typeof m.full_content !== 'string') m.full_content = '';
      if (!Array.isArray(m.entities)) m.entities = [];
      if (m.importance !== 'high' && m.importance !== 'normal') m.importance = 'normal';
      if (m.scope !== 'global' && m.scope !== 'project') m.scope = 'global';
      m.summary = m.summary.slice(0, 500);
      m.full_content = m.full_content.slice(0, 4000);
      m.entities = m.entities.filter((e: any) => typeof e === 'string').slice(0, 20);
      return true;
    });
    // W2: Validate updatedSummary is actually a string from LLM output
    const rawSummary = parsed.updatedSummary;
    const safeSummary = (typeof rawSummary === 'string' && rawSummary.trim())
      ? rawSummary.slice(0, 1000)
      : previousSummary;
    return {
      memories: validated,
      updatedSummary: safeSummary,
    };
  } catch {
    console.error('[extractor] Failed to parse LLM response');
    return { memories: [], updatedSummary: previousSummary };
  }
}

// ---------------------------------------------------------------------------
// ADD/UPDATE/NOOP logic against episodes table
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string;
  summary: string;
  full_content: string | null; // W6: Pre-fetched to avoid N+1 on merge
  entities: string | null;
  embedding: Buffer | null;
  access_count: number;
  scope: string;       // Fix #6: Track scope for boundary enforcement
  project: string | null; // Fix #6: Track project for boundary enforcement
}

/**
 * Fetch all episode rows needed for similarity dedup — call ONCE per extraction batch,
 * then pass the result to each upsertEpisode call.
 */
export function fetchEpisodeSnapshot(db: Database, projectName: string | null): EpisodeRow[] {
  // When projectName is null, NULL != NULL in SQL, so only fetch global episodes
  // Fix #6: Include scope and project for boundary enforcement in upsertEpisode
  // W6: Include full_content in snapshot to avoid N+1 query on merge
  return projectName
    ? db.prepare(
        `SELECT id, summary, full_content, entities, embedding, access_count, scope, project
         FROM episodes
         WHERE (scope = 'global' OR project = ?)
         AND embedding IS NOT NULL
         ORDER BY accessed_at DESC
         LIMIT 500`,
      ).all(projectName) as EpisodeRow[]
    : db.prepare(
        `SELECT id, summary, full_content, entities, embedding, access_count, scope, project
         FROM episodes
         WHERE scope = 'global'
         AND embedding IS NOT NULL
         ORDER BY accessed_at DESC
         LIMIT 500`,
      ).all() as EpisodeRow[];
}

export interface UpsertResult {
  action: 'add' | 'update' | 'noop';
  id?: string;
  embedding?: Buffer;
}

// I9: Hoist prepared statements — cache per Database instance to avoid
// recreating temporary statement objects on every upsertEpisode call
const stmtCache = new WeakMap<Database, {
  update: ReturnType<Database['prepare']>;
  insert: ReturnType<Database['prepare']>;
}>();

function getStatements(db: Database) {
  let stmts = stmtCache.get(db);
  if (!stmts) {
    stmts = {
      update: db.prepare(
        `UPDATE episodes
         SET summary = ?, full_content = ?, entities = ?,
             importance = ?, accessed_at = ?,
             access_count = access_count + 1
         WHERE id = ?`,
      ),
      insert: db.prepare(
        `INSERT INTO episodes (id, session_id, project, scope, summary, entities, importance, source_type, full_content, embedding, created_at, accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, 0)`,
      ),
    };
    stmtCache.set(db, stmts);
  }
  return stmts;
}

// W6: Batch-embed all candidate summaries in one call to avoid N+1 embedding requests
export async function batchEmbedCandidates(
  candidates: CandidateMemory[],
  embedProvider: EmbeddingProvider,
): Promise<(Buffer | null)[]> {
  if (candidates.length === 0) return [];
  const summaries = candidates.map(c => c.summary);
  const vectors = await embedProvider.embed(summaries);
  return vectors.map(v => v ? packEmbedding(v) : null);
}

export async function upsertEpisode(
  candidate: CandidateMemory,
  sessionId: string,
  projectName: string | null,
  embedProvider: EmbeddingProvider,
  db: Database,
  existingRows: EpisodeRow[],
  precomputedEmbedding?: Buffer | null,
): Promise<UpsertResult> {
  // W6: Use precomputed embedding if available, otherwise embed individually (fallback)
  let candidateBlob: Buffer;
  if (precomputedEmbedding) {
    candidateBlob = precomputedEmbedding;
  } else {
    const embeddings = await embedProvider.embed([candidate.summary]);
    const candidateVec = embeddings[0];
    if (!candidateVec) {
      console.error('[extractor] Failed to embed candidate — skipping');
      return { action: 'noop' };
    }
    candidateBlob = packEmbedding(candidateVec);
  }

  // Fix #6: Filter by compatible scope/project before similarity comparison
  // Global candidates match only global episodes; project candidates match same-project episodes
  const effectiveScope = (candidate.scope === 'project' && !projectName) ? 'global' : candidate.scope;
  const compatibleRows = existingRows.filter(row => {
    if (effectiveScope === 'global') return row.scope === 'global';
    return row.scope === 'project' && row.project === projectName;
  });

  let bestMatch: EpisodeRow | null = null;
  let bestSim = 0;

  for (const row of compatibleRows) {
    if (!row.embedding) continue;
    const sim = cosineSimilarity(candidateBlob, row.embedding as Buffer);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = row;
    }
  }

  const now = Date.now();
  const stmts = getStatements(db);

  if (bestMatch && bestSim > 0.92) {
    // APPEND new info to existing episode instead of replacing
    let mergedSummary = bestMatch.summary + ' | ' + candidate.summary;
    if (mergedSummary.length > 500) {
      mergedSummary = candidate.summary; // Keep newer if too long
    }

    // W6: Use pre-fetched full_content from snapshot (avoids N+1 query)
    let mergedContent = ((bestMatch.full_content ?? '') + '\n---\n' + candidate.full_content).trim();
    if (mergedContent.length > 4000) {
      mergedContent = mergedContent.slice(-4000); // Keep last 4000 chars instead of dropping old content
    }

    // W5: Re-embed merged summary so the vector matches the updated content.
    // Use candidateBlob (new summary's embedding) since the merged summary
    // is dominated by the new content when truncated.
    const updateEmbedding = candidateBlob;
    db.prepare('UPDATE episodes SET embedding = ? WHERE id = ?').run(updateEmbedding, bestMatch.id);

    stmts.update.run(
      mergedSummary,
      mergedContent,
      JSON.stringify(candidate.entities),
      candidate.importance,
      now,
      bestMatch.id,
    );
    return { action: 'update', id: bestMatch.id, embedding: updateEmbedding };
  }

  // effectiveScope already computed above (Fix #6 + I21)
  // ADD new episode
  const id = `ep_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  stmts.insert.run(
    id,
    sessionId,
    effectiveScope === 'project' ? projectName : null,
    effectiveScope,
    candidate.summary,
    JSON.stringify(candidate.entities),
    candidate.importance,
    candidate.full_content,
    candidateBlob,
    now,
    now,
  );
  return { action: 'add', id, embedding: candidateBlob };
}
