import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import OpenAI from 'openai';

const MODEL = 'text-embedding-3-small';
const DIMS = 1536;
const BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Pack / Unpack helpers — float32 array <-> Buffer for compact BLOB storage
// ---------------------------------------------------------------------------

export function packEmbedding(floats: number[]): Buffer {
  const arr = new Float32Array(floats);
  return Buffer.from(arr.buffer);
}

export function unpackEmbedding(blob: Buffer): Float32Array {
  const copy = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(copy);
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: Buffer, b: Buffer): number {
  const va = unpackEmbedding(a);
  const vb = unpackEmbedding(b);

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    normA += va[i] * va[i];
    normB += vb[i] * vb[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Cache layer (embedding_cache table)
// ---------------------------------------------------------------------------

function getCached(db: Database, hash: string): Buffer | null {
  const row = db
    .prepare('SELECT embedding FROM embedding_cache WHERE hash = ?')
    .get(hash) as { embedding: Buffer } | undefined;
  return row?.embedding ?? null;
}

function upsertCache(
  db: Database,
  hash: string,
  embedding: Buffer,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hash, embedding, DIMS, Date.now());
}

// ---------------------------------------------------------------------------
// OpenAI client factory
// ---------------------------------------------------------------------------

function getClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

// ---------------------------------------------------------------------------
// Core: embed a single text string
// ---------------------------------------------------------------------------

export async function embedText(
  db: Database,
  text: string,
  apiKey: string,
): Promise<Buffer> {
  const hash = sha256(text);

  // Cache hit — skip API call
  const cached = getCached(db, hash);
  if (cached) return cached;

  // Cache miss — call OpenAI
  const client = getClient(apiKey);
  const res = await client.embeddings.create({
    model: MODEL,
    input: text,
    dimensions: DIMS,
    encoding_format: 'float',
  });

  if (res.data[0].embedding.length !== DIMS) {
    throw new Error(`Expected ${DIMS} dims, got ${res.data[0].embedding.length}`);
  }

  const packed = packEmbedding(res.data[0].embedding);
  upsertCache(db, hash, packed);
  return packed;
}

// ---------------------------------------------------------------------------
// Batch embed — respects 100-text-per-request limit
// ---------------------------------------------------------------------------

export async function embedBatch(
  db: Database,
  texts: string[],
  apiKey: string,
): Promise<Buffer[]> {
  if (texts.length === 0) return [];

  // Pre-compute hashes and check cache for every input
  const hashes = texts.map(sha256);
  const results: (Buffer | null)[] = hashes.map((h) => getCached(db, h));

  // Collect indices that still need an API call
  const missIndices: number[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) missIndices.push(i);
  }

  // Fetch uncached embeddings in batches of BATCH_LIMIT
  if (missIndices.length > 0) {
    const client = getClient(apiKey);

    for (let start = 0; start < missIndices.length; start += BATCH_LIMIT) {
      const batchIdx = missIndices.slice(start, start + BATCH_LIMIT);
      const batchTexts = batchIdx.map((i) => texts[i]);

      const res = await client.embeddings.create({
        model: MODEL,
        input: batchTexts,
        dimensions: DIMS,
        encoding_format: 'float',
      });

      // OpenAI returns embeddings in the same order as input
      for (let j = 0; j < batchIdx.length; j++) {
        if (res.data[j].embedding.length !== DIMS) {
          throw new Error(`Expected ${DIMS} dims, got ${res.data[j].embedding.length}`);
        }
        const packed = packEmbedding(res.data[j].embedding);
        const originalIdx = batchIdx[j];
        results[originalIdx] = packed;
        upsertCache(db, hashes[originalIdx], packed);
      }
    }
  }

  // Every slot is now filled
  return results as Buffer[];
}
