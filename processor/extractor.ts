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
): Promise<ExtractionResult> {
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
    if (!parsed || !Array.isArray(parsed.memories)) {
      console.error('[extractor] LLM returned invalid shape');
      return { memories: [], updatedSummary: previousSummary };
    }
    return {
      memories: parsed.memories,
      updatedSummary: parsed.updatedSummary ?? previousSummary,
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
  entities: string | null;
  embedding: Buffer | null;
  access_count: number;
}

/**
 * Fetch all episode rows needed for similarity dedup — call ONCE per extraction batch,
 * then pass the result to each upsertEpisode call.
 */
export function fetchEpisodeSnapshot(db: Database, projectName: string | null): EpisodeRow[] {
  return db.prepare(
    `SELECT id, summary, entities, embedding, access_count
     FROM episodes
     WHERE (scope = 'global' OR project = ?)
     AND embedding IS NOT NULL`,
  ).all(projectName) as EpisodeRow[];
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
             importance = ?, embedding = ?, accessed_at = ?,
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

export async function upsertEpisode(
  candidate: CandidateMemory,
  sessionId: string,
  projectName: string | null,
  embedProvider: EmbeddingProvider,
  db: Database,
  existingRows: EpisodeRow[],
): Promise<UpsertResult> {
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

  let bestMatch: EpisodeRow | null = null;
  let bestSim = 0;

  for (const row of rows) {
    if (!row.embedding) continue;
    const sim = cosineSimilarity(candidateBlob, row.embedding as Buffer);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = row;
    }
  }

  const now = Date.now();
  const stmts = getStatements(db);

  if (bestMatch && bestSim > 0.85) {
    // UPDATE existing episode
    stmts.update.run(
      candidate.summary,
      candidate.full_content,
      JSON.stringify(candidate.entities),
      candidate.importance,
      candidateBlob,
      now,
      bestMatch.id,
    );
    // C3: Return id and embedding so caller can update its snapshot
    return { action: 'update', id: bestMatch.id, embedding: candidateBlob };
  }

  // I21: Force scope to 'global' when projectName is null to prevent unreachable episodes
  const effectiveScope = (candidate.scope === 'project' && !projectName) ? 'global' : candidate.scope;

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
