import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const DIMS = 768;

// ---------------------------------------------------------------------------
// EmbeddingProvider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<(Float32Array | null)[]>;
}

// ---------------------------------------------------------------------------
// LocalGGUFProvider — uses node-llama-cpp with nomic-embed-text
// ---------------------------------------------------------------------------

const GGUF_MODEL_URI = 'hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const MODELS_DIR = path.join(os.homedir(), '.claude-memory', 'models');

export class LocalGGUFProvider implements EmbeddingProvider {
  private context: any = null; // lazily initialised LlamaEmbeddingContext
  private initPromise: Promise<void> | null = null;
  // Mutex: GGUF model is single-threaded — serialize embed calls to prevent
  // concurrent access that causes "Failed to embed" errors during burst loads
  private embedQueue: Promise<any> = Promise.resolve();

  private async ensureContext(): Promise<void> {
    if (this.context) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Dynamic import — node-llama-cpp is heavy and optional
        const { getLlama, resolveModelFile } = await import('node-llama-cpp');

        // Ensure models directory exists
        fs.mkdirSync(MODELS_DIR, { recursive: true });

        // resolveModelFile auto-downloads if not cached
        console.error('[providers] Resolving local GGUF model...');
        // @ts-ignore — resolveModelFile signature varies across node-llama-cpp versions; works at runtime
        const modelPath = await resolveModelFile(GGUF_MODEL_URI, MODELS_DIR, {
          cli: false,
        });
        console.error(`[providers] Model path: ${modelPath}`);

        const llama = await getLlama();
        const model = await llama.loadModel({ modelPath });
        this.context = await model.createEmbeddingContext();
        console.error('[providers] LocalGGUFProvider ready');
      } catch (err) {
        this.initPromise = null; // allow retry on next call
        throw err;
      }
    })();

    return this.initPromise;
  }

  async embed(texts: string[]): Promise<(Float32Array | null)[]> {
    // Serialize through mutex — GGUF model can't handle concurrent calls
    const ticket = this.embedQueue.then(() => this._doEmbed(texts));
    this.embedQueue = ticket.catch(() => {}); // swallow rejection in chain
    return ticket;
  }

  private async _doEmbed(texts: string[]): Promise<(Float32Array | null)[]> {
    await this.ensureContext();
    if (!this.context) {
      throw new Error('Embedding context failed to initialize');
    }

    const results: Float32Array[] = [];
    for (const text of texts) {
      const embedding = await this.context.getEmbeddingFor(text);
      // embedding.vector is number[] — convert to Float32Array
      const vec = new Float32Array(embedding.vector);
      if (vec.length !== DIMS) {
        throw new Error(
          `LocalGGUF: expected ${DIMS} dims, got ${vec.length}`,
        );
      }
      results.push(vec);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// OpenAIProvider — extracted from embeddings.ts
// ---------------------------------------------------------------------------

const OPENAI_MODEL = 'text-embedding-3-small';
const BATCH_LIMIT = 100;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function getCached(db: Database, hash: string): Buffer | null {
  const row = db
    .prepare('SELECT embedding FROM embedding_cache WHERE hash = ?')
    .get(hash) as { embedding: Buffer } | undefined;
  return row?.embedding ?? null;
}

function upsertCache(db: Database, hash: string, embedding: Buffer): void {
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hash, embedding, DIMS, Date.now());
}

export class OpenAIProvider implements EmbeddingProvider {
  private apiKey: string;
  private db: Database;
  private client: any = null; // lazily initialised OpenAI client

  constructor(apiKey: string, db: Database) {
    this.apiKey = apiKey;
    this.db = db;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    const { default: OpenAI } = await import('openai');
    this.client = new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }

  async embed(texts: string[]): Promise<(Float32Array | null)[]> {
    if (texts.length === 0) return [];

    // Pre-compute hashes and check cache
    const hashes = texts.map(sha256);
    const results: (Float32Array | null)[] = hashes.map((h) => {
      const cached = getCached(this.db, h);
      if (cached) {
        const copy = cached.buffer.slice(
          cached.byteOffset,
          cached.byteOffset + cached.byteLength,
        );
        return new Float32Array(copy);
      }
      return null;
    });

    // Collect indices that still need an API call
    const missIndices: number[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) missIndices.push(i);
    }

    // Fetch uncached embeddings in batches of BATCH_LIMIT
    if (missIndices.length > 0) {
      const client = await this.getClient();

      for (let start = 0; start < missIndices.length; start += BATCH_LIMIT) {
        const batchIdx = missIndices.slice(start, start + BATCH_LIMIT);
        const batchTexts = batchIdx.map((i) => texts[i]);

        const res = await client.embeddings.create({
          model: OPENAI_MODEL,
          input: batchTexts,
          dimensions: DIMS,
          encoding_format: 'float',
        });

        for (let j = 0; j < batchIdx.length; j++) {
          const vec = res.data[j].embedding;
          if (vec.length !== DIMS) {
            throw new Error(
              `OpenAI: expected ${DIMS} dims, got ${vec.length}`,
            );
          }
          const arr = new Float32Array(vec);
          const packed = Buffer.from(arr.buffer);
          const originalIdx = batchIdx[j];
          results[originalIdx] = arr;
          upsertCache(this.db, hashes[originalIdx], packed);
        }
      }
    }

    return results as Float32Array[];
  }
}

// ---------------------------------------------------------------------------
// FallbackChain — tries providers in order, falls back on failure
// ---------------------------------------------------------------------------

export class FallbackChain implements EmbeddingProvider {
  private providers: EmbeddingProvider[];

  constructor(providers: EmbeddingProvider[]) {
    this.providers = providers;
  }

  async embed(texts: string[]): Promise<(Float32Array | null)[]> {
    for (const provider of this.providers) {
      try {
        const result = await provider.embed(texts);
        return result;
      } catch (err) {
        const name = provider.constructor.name;
        console.error(
          `[providers] ${name} failed: ${(err as Error).message}`,
        );
        // fall through to next provider
      }
    }

    // All providers failed — signal BM25-only mode
    console.error(
      '[providers] All embedding providers failed — falling back to BM25-only',
    );
    return texts.map(() => null);
  }
}

// ---------------------------------------------------------------------------
// Factory: create the default provider chain
// ---------------------------------------------------------------------------

export function createProviderChain(
  apiKey: string | undefined,
  db: Database,
): FallbackChain {
  const providers: EmbeddingProvider[] = [];

  // 1. Local GGUF (preferred — no API key needed, runs on device)
  providers.push(new LocalGGUFProvider());

  // 2. OpenAI fallback (if API key is available)
  if (apiKey) {
    providers.push(new OpenAIProvider(apiKey, db));
  }

  return new FallbackChain(providers);
}
