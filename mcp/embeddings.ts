// ---------------------------------------------------------------------------
// Embedding utilities — pack/unpack helpers and cosine similarity.
//
// The actual embedding providers (LocalGGUF, OpenAI, FallbackChain)
// live in providers.ts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pack / Unpack helpers — float32 array <-> Buffer for compact BLOB storage
// ---------------------------------------------------------------------------

export function packEmbedding(floats: number[] | Float32Array): Buffer {
  const arr = floats instanceof Float32Array ? floats : new Float32Array(floats);
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
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

  // Dimension mismatch guard — incompatible embeddings score 0
  if (va.length !== vb.length) {
    console.error(`[embeddings] Dimension mismatch: ${va.length} vs ${vb.length} — returning 0`);
    return 0;
  }

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
