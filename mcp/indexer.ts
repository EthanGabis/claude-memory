import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fsSync from 'fs';
import fsAsync from 'node:fs/promises';
import path from 'path';
import type { EmbeddingProvider } from './providers.js';
import { packEmbedding } from './embeddings.js';
import { get_encoding } from 'tiktoken';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChunkRecord {
  id: string;
  path: string;
  layer: 'global' | 'project';
  project: string | null;
  startLine: number;
  endLine: number;
  hash: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Tokeniser (singleton — expensive to create)
// ---------------------------------------------------------------------------

let _enc: ReturnType<typeof get_encoding> | null = null;

function getEncoder() {
  if (!_enc) {
    _enc = get_encoding('cl100k_base');
  }
  return _enc;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 400;   // tokens
const OVERLAP = 80;       // tokens

/**
 * Split file text into overlapping token chunks, tracking approximate
 * start_line and end_line for each chunk.
 */
function chunkText(
  text: string,
  filePath: string,
  layer: 'global' | 'project',
  project: string | null,
): ChunkRecord[] {
  const enc = getEncoder();
  const tokens = enc.encode(text);

  if (tokens.length === 0) return [];

  // Pre-compute a mapping: for each byte offset in `text`, which line is it on?
  // We'll use this to convert token spans back to line numbers.
  const lineStarts: number[] = [0]; // byte offset where each line begins
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  /** Given a character offset, return the 1-based line number. */
  function charOffsetToLine(offset: number): number {
    // Binary search for the last lineStart <= offset
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1; // 1-based
  }

  const chunks: ChunkRecord[] = [];
  const step = CHUNK_SIZE - OVERLAP; // 320 tokens per step
  const decoder = new TextDecoder();
  let charOffset = 0;

  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + CHUNK_SIZE, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    const chunkText = decoder.decode(enc.decode(chunkTokens));

    const startLine = charOffsetToLine(charOffset);
    const endLine = charOffsetToLine(Math.max(0, charOffset + chunkText.length - 1));

    const id = createHash('sha256')
      .update(`${filePath}:${start}`)
      .digest('hex');

    const hash = createHash('sha256')
      .update(chunkText)
      .digest('hex');

    chunks.push({
      id,
      path: filePath,
      layer,
      project: project ?? null,
      startLine,
      endLine,
      hash,
      text: chunkText,
    });

    // If we've consumed all tokens, stop (avoid a trailing micro-chunk
    // that would be created by the next iteration).
    if (end >= tokens.length) break;

    // Advance charOffset by the non-overlapping step's character length
    const stepChars = decoder.decode(enc.decode(tokens.slice(start, start + step))).length;
    charOffset += stepChars;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

/**
 * Index a single Markdown file — deletes existing chunks for this path,
 * then inserts new ones inside a transaction. When an EmbeddingProvider is
 * supplied, embeds all chunks immediately after insertion.
 *
 * Returns the number of chunks created.
 */
export async function indexFile(
  db: Database,
  filePath: string,
  layer: 'global' | 'project',
  project?: string,
  provider?: EmbeddingProvider | null,
  projectPath?: string | null,
): Promise<number> {
  let content: string;
  try {
    content = await fsAsync.readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[indexer] skipping unreadable file: ${filePath}`, (err as Error).message);
    return 0;
  }

  if (!content.trim()) return 0;

  const chunks = chunkText(content, filePath, layer, project ?? null);
  if (chunks.length === 0) return 0;

  const now = Date.now();

  const deleteStmt = db.prepare('DELETE FROM chunks WHERE path = ?');
  const insertStmt = db.prepare(`
    INSERT INTO chunks (id, path, layer, project, project_path, start_line, end_line, hash, text, embedding, updated_at)
    VALUES ($id, $path, $layer, $project, $projectPath, $startLine, $endLine, $hash, $text, NULL, $updatedAt)
  `);

  const updateEmbStmt = db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');

  const runTransaction = db.transaction((chunks: ChunkRecord[], embeddings: (Float32Array | null)[] | null) => {
    deleteStmt.run(filePath);
    for (const chunk of chunks) {
      insertStmt.run({
        $id: chunk.id,
        $path: chunk.path,
        $layer: chunk.layer,
        $project: chunk.project,
        $projectPath: projectPath ?? null,
        $startLine: chunk.startLine,
        $endLine: chunk.endLine,
        $hash: chunk.hash,
        $text: chunk.text,
        $updatedAt: now,
      });
    }
    // I13: Embed updates inside the same transaction so a crash can't leave
    // chunks with null embeddings after embeddings were successfully computed
    if (embeddings) {
      for (let i = 0; i < chunks.length; i++) {
        const emb = embeddings[i];
        if (emb != null) {
          updateEmbStmt.run(packEmbedding(emb), chunks[i].id);
        }
      }
    }
  });

  // Compute embeddings BEFORE the transaction (async I/O required)
  let embeddings: (Float32Array | null)[] | null = null;
  if (provider) {
    const texts = chunks.map(c => c.text);
    embeddings = await provider.embed(texts);
  }

  // Run DELETE + INSERT + UPDATE all atomically
  runTransaction(chunks, embeddings);

  return chunks.length;
}

// ---------------------------------------------------------------------------
// Directory indexing
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under a directory.
 */
function collectMarkdownFiles(dirPath: string): string[] {
  const results: string[] = [];

  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    console.warn(`[indexer] skipping unreadable directory: ${dirPath}`);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden directories and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Index all .md files in a directory recursively.
 *
 * Returns total chunk count.
 */
export async function indexDirectory(
  db: Database,
  dirPath: string,
  layer: 'global' | 'project',
  project?: string,
  provider?: EmbeddingProvider | null,
  projectPath?: string | null,
): Promise<number> {
  const files = collectMarkdownFiles(dirPath);
  let totalChunks = 0;

  for (const file of files) {
    totalChunks += await indexFile(db, file, layer, project, provider, projectPath);
  }

  return totalChunks;
}

// ---------------------------------------------------------------------------
// Backfill embeddings for chunks that have none
// ---------------------------------------------------------------------------

/**
 * Re-index all files that contain at least one chunk with a NULL embedding.
 * Yields the event loop between files to avoid blocking.
 */
export async function backfillEmbeddings(
  db: Database,
  provider: EmbeddingProvider,
): Promise<void> {
  const paths = db.prepare(
    "SELECT DISTINCT path FROM chunks WHERE embedding IS NULL"
  ).all() as { path: string }[];

  for (const { path: filePath } of paths) {
    // Detect layer and project from path
    const layer: 'global' | 'project' = filePath.includes('/.claude-memory/') ? 'global' : 'project';
    const segments = filePath.split('/');
    let project: string | undefined;
    if (layer === 'project') {
      // Find the segment before .claude in the path
      const claudeIdx = segments.indexOf('.claude');
      if (claudeIdx > 0) {
        project = segments[claudeIdx - 1];
      }
    }

    // Look up projectPath from the projects table for proper chunk tagging
    const projectRow = project
      ? (db.prepare('SELECT full_path FROM projects WHERE name = ? ORDER BY full_path LIMIT 1').get(project) as { full_path: string } | null)
      : null;
    const projectPath = projectRow?.full_path ?? null;

    try {
      await indexFile(db, filePath, layer, project, provider, projectPath);
    } catch (err) {
      console.error(`[indexer] Backfill failed for ${path.basename(filePath)}: ${(err as Error).message}`);
    }

    // Yield to event loop between files to avoid blocking
    await new Promise(r => setTimeout(r, 0));
  }
}
