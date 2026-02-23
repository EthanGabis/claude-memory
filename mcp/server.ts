import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';

import { initDb, DB_PATH } from './schema.js';
import { packEmbedding, cosineSimilarity } from './embeddings.js';
import { search, type SearchResult } from './search.js';
import { indexFile, backfillEmbeddings } from './indexer.js';
import { createProviderChain } from './providers.js';
import { startWatcher, discoverProjectMemoryDirs } from './watcher.js';
import { withFileLock } from '../shared/file-lock.js';
import { resolveProjectFromCwd } from '../shared/project-resolver.js';
import { SOCKET_PATH } from '../shared/uds.js';

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    '[claude-memory] OPENAI_API_KEY is not set. Local GGUF provider will be used if available; falling back to BM25-only search.',
  );
}

const db = initDb(DB_PATH);

// Tracks paths recently written by memory_save to suppress watcher double-index
const recentlySaved = new Set<string>();

// Cached project memory dirs discovered at startup (avoids synchronous walk on every request)
let cachedProjectMemoryDirs: string[] = [];

// Initialize embedding provider chain (local GGUF -> OpenAI -> BM25-only)
const provider = createProviderChain(apiKey, db);

// ---------------------------------------------------------------------------
// Project detection — thin adapter over shared/project-resolver.ts
// ---------------------------------------------------------------------------

function detectProject(startDir?: string): { root: string; name: string } | null {
  const info = resolveProjectFromCwd(startDir ?? process.cwd());
  if (!info.name || !info.fullPath) return null;
  return { root: info.fullPath, name: info.name };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';

  return results
    .map((r, i) => {
      const lines =
        r.startLine === r.endLine
          ? `L${r.startLine}`
          : `L${r.startLine}-${r.endLine}`;
      const score = r.score.toFixed(3);
      const snippet =
        r.text.length > 500 ? r.text.slice(0, 500) + '...' : r.text;
      return `[${i + 1}] ${r.path} (${lines}) — score ${score}\n${snippet}`;
    })
    .join('\n\n---\n\n');
}

function todayString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'claude-memory', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// -- List tools -----------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description:
        'Search memory (daily logs and MEMORY.md files) using hybrid BM25 + vector search with temporal decay. Returns ranked results with file path, line range, score, and text snippet.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 10)',
          },
          project: {
            type: 'string',
            description:
              'Filter results to a specific project name. Omit to search all layers.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_get',
      description:
        'Read a specific memory file by path. Returns text content, resolved path, and whether content was truncated. Returns empty text (no error) if file does not exist.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description:
              'Workspace-relative path (e.g. "MEMORY.md" or "memory/2026-02-21.md")',
          },
          startLine: {
            type: 'number',
            description: 'Optional 1-based start line number',
          },
          lineCount: {
            type: 'number',
            description: 'Optional number of lines to read (requires startLine)',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'memory_save',
      description:
        'Save content to memory. target="log" (default) appends to today\'s daily log. target="memory" appends to MEMORY.md with dedup check.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: {
            type: 'string',
            description: 'The content to save',
          },
          target: {
            type: 'string',
            enum: ['log', 'memory'],
            description:
              'Where to save: "log" for daily log (default), "memory" for MEMORY.md',
          },
          cwd: {
            type: 'string',
            description:
              'Optional working directory path to use for project detection instead of the server process CWD',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'memory_recall',
      description:
        "Get brief memory recollections for a topic. Returns short 'memory bites' that you can expand with memory_expand(). Use this when you want to check what you remember about a topic.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'The topic or question to recall memories about',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of memory bites to return (default 5)',
          },
          project: {
            type: 'string',
            description:
              'Filter results to a specific project name. Omit to search all scopes.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_expand',
      description:
        'Expand a memory recollection to get full context. Pass the episode ID from memory_recall results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'The episode ID from memory_recall results (e.g. "ep_abc123")',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_forget',
      description:
        'Delete a specific memory episode by ID. Use this to remove incorrect or outdated memories.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Episode ID to delete (from memory_recall results)',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'memory_status',
      description:
        'Check Engram daemon health, episode counts, and system status.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

// -- Call tool -------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'memory_search') {
    return handleMemorySearch(args as { query: string; limit?: number; project?: string });
  }

  if (name === 'memory_get') {
    return handleMemoryGet(args as { path: string; startLine?: number; lineCount?: number });
  }

  if (name === 'memory_save') {
    return handleMemorySave(args as { content: string; target?: 'log' | 'memory'; cwd?: string });
  }

  if (name === 'memory_recall') {
    return handleMemoryRecall(args as { query: string; limit?: number; project?: string });
  }

  if (name === 'memory_expand') {
    return handleMemoryExpand(args as { id: string });
  }

  if (name === 'memory_forget') {
    return handleMemoryForget(args as { id: string });
  }

  if (name === 'memory_status') {
    return handleMemoryStatus();
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Tool: memory_search
// ---------------------------------------------------------------------------

async function handleMemorySearch(args: {
  query: string;
  limit?: number;
  project?: string;
}) {
  const { query, limit, project } = args;
  const effectiveLimit = Math.max(1, Math.min(limit ?? 10, 50));

  try {
    const embeddingResults = await provider.embed([query]);
    const queryVec = embeddingResults[0];

    let queryEmbedding: Buffer;
    if (queryVec) {
      queryEmbedding = packEmbedding(queryVec);
    } else {
      // BM25-only fallback: zero vector (search.ts handles zero-vector gracefully)
      queryEmbedding = packEmbedding(new Float32Array(768));
    }

    const results = search(db, queryEmbedding, query, effectiveLimit, project);
    const formatted = formatResults(results);

    return {
      content: [{ type: 'text' as const, text: formatted }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Search failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_get
// ---------------------------------------------------------------------------

async function handleMemoryGet(args: {
  path: string;
  startLine?: number;
  lineCount?: number;
}) {
  if (!args.path || args.path.trim() === '') {
    return {
      content: [{ type: 'text' as const, text: 'Access denied: path must not be empty' }],
      isError: true,
    };
  }

  const { startLine, lineCount } = args;

  // Build list of allowed roots: global first, then CWD project, then all
  // discovered project memory dirs (cached at startup; watcher handles new dirs)
  const globalRoot = path.join(os.homedir(), '.claude-memory');
  const allowedRoots = [globalRoot];

  const project = detectProject();
  if (project) {
    allowedRoots.push(path.join(project.root, '.claude', 'memory'));
  }

  // Also include all cached project memory dirs (covers projects not
  // ancestors of the server CWD)
  for (const dir of cachedProjectMemoryDirs) {
    if (!allowedRoots.includes(dir)) {
      allowedRoots.push(dir);
    }
  }

  // Resolve path safely — must stay within an allowed root.
  // Try each root in order; prefer the first one where the file actually exists.
  let resolvedPath: string | null = null;   // first security-valid candidate (fallback)
  let resolvedPathExists: string | null = null; // first candidate that exists on disk

  for (const root of allowedRoots) {
    // Normalize root to strip trailing separator (guards against doubled separators
    // when CLAUDE_MEMORY_PROJECT_ROOTS has trailing slashes)
    const normalizedRoot = root.endsWith(path.sep) ? root.slice(0, -1) : root;

    const candidate = path.resolve(normalizedRoot, args.path);

    // Resolve symlinks before the boundary check to prevent symlink escape
    const realCandidate = await fs.realpath(candidate).catch(() => candidate);

    if (realCandidate.startsWith(normalizedRoot + path.sep) || realCandidate === normalizedRoot) {
      // Security check passed
      if (!resolvedPath) {
        resolvedPath = realCandidate; // remember first valid candidate as fallback
      }
      // Check if the file actually exists at this candidate
      try {
        await fs.access(realCandidate);
        resolvedPathExists = realCandidate;
        break; // found an existing file — use it
      } catch {
        // File doesn't exist at this root — try next
      }
    }
  }

  // Use the existing-file path if found, otherwise fall back to the first
  // security-valid path (will yield empty-text ENOENT response, same as before)
  const effectivePath = resolvedPathExists ?? resolvedPath;

  if (!effectivePath) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Access denied: path is outside allowed memory directories',
        },
      ],
      isError: true,
    };
  }

  // Read file — return empty on ENOENT, never throw
  let content: string;
  try {
    content = await fs.readFile(effectivePath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ text: '', path: effectivePath, truncated: false }),
          },
        ],
      };
    }
    if (err.code === 'EISDIR') {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Access denied: path resolves to a directory, not a file',
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Read failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }

  // Validate line parameters
  if (startLine !== undefined && startLine < 1) {
    return {
      content: [{ type: 'text' as const, text: 'startLine must be >= 1' }],
      isError: true,
    };
  }

  if (lineCount !== undefined && lineCount < 1) {
    return {
      content: [{ type: 'text' as const, text: 'lineCount must be >= 1' }],
      isError: true,
    };
  }

  // Slice lines if requested
  const effectiveStartLine = startLine ?? (lineCount !== undefined ? 1 : undefined);
  if (effectiveStartLine !== undefined) {
    const lines = content.split('\n');
    const start = effectiveStartLine - 1; // convert to 0-based
    const end = lineCount !== undefined ? start + lineCount : lines.length;
    content = lines.slice(start, end).join('\n');
  }

  // Cap at 10K chars
  const MAX_CHARS = 10_000;
  const truncated = content.length > MAX_CHARS;
  if (truncated) content = content.slice(0, MAX_CHARS);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ text: content, path: effectivePath, truncated }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_save
// ---------------------------------------------------------------------------

async function handleMemorySave(args: {
  content: string;
  target?: 'log' | 'memory';
  cwd?: string;
}) {
  const { content, target = 'log' } = args;
  const project = detectProject(args.cwd as string | undefined);

  try {
    if (target === 'log') {
      return await saveToLog(content, project);
    } else {
      return await saveToMemory(content, project);
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Save failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

async function saveToLog(
  content: string,
  project: { root: string; name: string } | null,
) {
  const today = todayString();
  let logPath: string;
  let layer: 'global' | 'project';
  let projectName: string | undefined;

  if (project) {
    logPath = path.join(project.root, '.claude', 'memory', `${today}.md`);
    layer = 'project';
    projectName = project.name;
  } else {
    logPath = path.join(os.homedir(), '.claude-memory', 'memory', `${today}.md`);
    layer = 'global';
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(logPath), { recursive: true });

  // Append content with a newline separator
  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const entry = `\n## ${timestamp}\n\n${content}\n`;

  // Mark path as recently saved BEFORE writing so concurrent searches see the dedup flag
  recentlySaved.add(logPath);
  setTimeout(() => recentlySaved.delete(logPath), 3000);

  await fs.appendFile(logPath, entry, 'utf-8');

  // Re-index the file
  await indexFile(db, logPath, layer, projectName, provider);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Saved to daily log: ${logPath}`,
      },
    ],
  };
}

async function saveToMemory(
  content: string,
  project: { root: string; name: string } | null,
) {
  let memoryPath: string;
  let layer: 'global' | 'project';
  let projectName: string | undefined;

  if (project) {
    memoryPath = path.join(project.root, '.claude', 'memory', 'MEMORY.md');
    layer = 'project';
    projectName = project.name;
  } else {
    memoryPath = path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
    layer = 'global';
  }

  // Ensure directory exists
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });

  const result = await withFileLock(memoryPath + '.lock', async () => {
    // Read existing content
    let existing = '';
    try {
      existing = await fs.readFile(memoryPath, 'utf-8');
    } catch {
      // File doesn't exist yet — will be created
    }

    // Simple substring dedup: check if the content is already present
    if (existing.includes(content.trim())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Content already recorded in ${memoryPath} — skipped.`,
          },
        ],
      };
    }

    // Build the new entry and rewrite the whole file (never blind-append)
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp}\n${content}\n`;
    const newContent = existing + entry;

    // Atomic write: temp file + rename to prevent corruption on crash
    const tmpPath = memoryPath + '.tmp.' + process.pid;
    await fs.writeFile(tmpPath, newContent, 'utf-8');
    await fs.rename(tmpPath, memoryPath);

    // Mark path as recently saved INSIDE the lock so watcher is suppressed
    // before the lock releases and the file-change event fires
    recentlySaved.add(memoryPath);
    setTimeout(() => recentlySaved.delete(memoryPath), 5000);

    return null; // success — continue with indexing outside the lock
  });

  if (result) return result; // dedup short-circuit

  // Re-index the file (outside the lock — indexing doesn't need it).
  // Note: the consolidator also writes MEMORY.md but does NOT add to recentlySaved.
  // This is intentional — the consolidator runs in the processor process (not the
  // MCP server), so the MCP server's watcher will correctly re-index the changes.
  await indexFile(db, memoryPath, layer, projectName, provider);

  return {
    content: [
      {
        type: 'text' as const,
        text: `Saved to MEMORY.md: ${memoryPath}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: memory_recall
// ---------------------------------------------------------------------------

interface EpisodeRow {
  id: string;
  session_id: string;
  project: string | null;
  scope: string;
  summary: string;
  entities: string | null;
  importance: string;
  source_type: string;
  full_content: string | null;
  embedding: Buffer | null;
  created_at: number;
  accessed_at: number;
  access_count: number;
  rowid?: number;
}

interface EpisodeBM25Row {
  rowid: number;
  score: number;
}

async function handleMemoryRecall(args: {
  query: string;
  limit?: number;
  project?: string;
}) {
  const { query, limit } = args;
  // C2: Default to current project when no project arg — prevents leaking
  // project-scoped memories from other projects in recall results
  const project = args.project ?? detectProject()?.name ?? undefined;
  const effectiveLimit = Math.max(1, Math.min(limit ?? 5, 50));

  try {
    // 1. Embed query using provider chain
    const embeddingResults = await provider.embed([query]);
    const queryVec = embeddingResults[0];
    let queryEmbedding: Buffer;
    if (queryVec) {
      queryEmbedding = packEmbedding(queryVec);
    } else {
      queryEmbedding = packEmbedding(new Float32Array(768));
    }

    // 2. BM25 search on episodes_fts
    const FTS5_RESERVED = new Set(['OR', 'AND', 'NOT', 'NEAR']);
    const ftsQuery = query
      .trim()
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(t => !FTS5_RESERVED.has(t.toUpperCase())) // strip FTS5 reserved words
      .join(' OR ');

    const candidateCount = effectiveLimit * 3;

    let bm25Rows: EpisodeBM25Row[] = [];
    try {
      bm25Rows = db
        .prepare(
          'SELECT rowid, bm25(episodes_fts) as score FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts) LIMIT ?',
        )
        .all(ftsQuery, candidateCount) as EpisodeBM25Row[];
    } catch {
      // FTS may fail on empty or invalid query — fall back to vector-only
    }

    // 3. Collect candidate episodes (BM25 hits + vector scan for broader coverage)
    const candidateMap = new Map<string, { episode: EpisodeRow; rawBM25: number }>();

    // BM25 candidates
    const episodeByRowid = project
      ? db.prepare('SELECT *, rowid FROM episodes WHERE rowid = ? AND (scope = \'global\' OR project = ?)')
      : db.prepare('SELECT *, rowid FROM episodes WHERE rowid = ?');

    for (const row of bm25Rows) {
      const episode = (
        project
          ? episodeByRowid.get(row.rowid, project)
          : episodeByRowid.get(row.rowid)
      ) as EpisodeRow | undefined;
      if (episode) {
        candidateMap.set(episode.id, { episode, rawBM25: row.score });
      }
    }

    // Also fetch recent episodes with embeddings for vector-only matches
    const recentEpisodes = (
      project
        ? db.prepare(
            'SELECT *, rowid FROM episodes WHERE embedding IS NOT NULL AND (scope = \'global\' OR project = ?) ORDER BY created_at DESC LIMIT ?',
          ).all(project, candidateCount)
        : db.prepare(
            'SELECT *, rowid FROM episodes WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?',
          ).all(candidateCount)
    ) as EpisodeRow[];

    for (const ep of recentEpisodes) {
      if (!candidateMap.has(ep.id)) {
        candidateMap.set(ep.id, { episode: ep, rawBM25: 0 });
      }
    }

    if (candidateMap.size === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No memories found for that topic.' }],
      };
    }

    // 4. Score candidates: 0.5*relevance + 0.3*recency + 0.2*accessFrequency
    const now = Date.now();
    const candidates = Array.from(candidateMap.values());

    // Normalize BM25 scores
    const rawBM25Scores = candidates.map((c) => c.rawBM25).filter((s) => s !== 0);
    const bm25Min = rawBM25Scores.length > 0 ? Math.min(...rawBM25Scores) : 0;
    const bm25Max = rawBM25Scores.length > 0 ? Math.max(...rawBM25Scores) : 0;

    // Normalize access counts
    const accessCounts = candidates.map((c) => c.episode.access_count);
    const maxAccess = Math.max(...accessCounts, 1);

    interface ScoredEpisode {
      episode: EpisodeRow;
      score: number;
    }

    const scored: ScoredEpisode[] = candidates.map((c) => {
      // Vector similarity
      let vectorScore = 0;
      if (c.episode.embedding) {
        vectorScore = cosineSimilarity(queryEmbedding, c.episode.embedding as Buffer);
      }

      // Normalized BM25 — only episodes with a real BM25 hit participate
      let bm25Score = 0;
      if (c.rawBM25 !== 0) {
        if (bm25Min === bm25Max) {
          bm25Score = 0.5; // Single hit gets moderate BM25 score, not full
        } else {
          bm25Score = (c.rawBM25 - bm25Max) / (bm25Min - bm25Max);
        }
      }

      // Combined relevance (same weighting as search.ts)
      const relevance = 0.7 * vectorScore + 0.3 * bm25Score;

      // Recency: exponential decay, 30-day half-life
      const ageInDays = (now - c.episode.created_at) / 86_400_000;
      const recency = Math.exp(-(Math.LN2 / 30) * ageInDays);

      // Access frequency: Laplace-smoothed, normalized 0..1
      const accessFreq = (c.episode.access_count + 1) / (maxAccess + 1);

      // High-importance memories get minimum relevance floor of 0.3
      const effectiveRelevance = (c.episode.importance === 'high') ? Math.max(relevance, 0.3) : relevance;

      // Final score: 0.5*relevance + 0.3*recency + 0.2*accessFrequency
      const finalScore = 0.5 * effectiveRelevance + 0.3 * recency + 0.2 * accessFreq;

      return { episode: c.episode, score: finalScore };
    });

    // Sort by score descending and take top results
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, effectiveLimit);

    // 5. Update accessed_at for returned episodes (access_count is
    //    incremented only in memory_expand, not on recall)
    const updateStmt = db.prepare(
      'UPDATE episodes SET accessed_at = ? WHERE id = ?',
    );
    for (const r of topResults) {
      updateStmt.run(now, r.episode.id);
    }

    // 6. Format output
    const formatted = topResults
      .map((r, i) => {
        const date = new Date(r.episode.created_at);
        const monthStr = date.toLocaleString('en-US', { month: 'short' });
        const dayStr = date.getDate();
        const importanceTag = r.episode.importance === 'high' ? 'high' : 'normal';
        return `[${i + 1}] (${monthStr} ${dayStr}, ${importanceTag}) ${r.episode.summary} — ID: ${r.episode.id}`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text' as const,
          text: topResults.length > 0
            ? formatted
            : 'No memories found for that topic.',
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory recall failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_expand
// ---------------------------------------------------------------------------

async function handleMemoryExpand(args: { id: string }) {
  const { id } = args;

  try {
    const episode = db
      .prepare('SELECT * FROM episodes WHERE id = ?')
      .get(id) as EpisodeRow | undefined;

    if (!episode) {
      return {
        content: [{ type: 'text' as const, text: 'No memory found with that ID.' }],
      };
    }

    // C1: Scope/project boundary check — only allow expanding episodes
    // that are global or belong to the current project (prevents cross-project leaks)
    if (episode.scope === 'project' && episode.project) {
      const currentProject = detectProject();
      if (!currentProject || currentProject.name !== episode.project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Cannot expand memory from project "${episode.project}" — not the current project.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Update accessed_at and access_count
    const now = Date.now();
    db.prepare(
      'UPDATE episodes SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    ).run(now, id);

    // Format entities
    let entitiesStr = 'None';
    if (episode.entities) {
      try {
        const parsed = JSON.parse(episode.entities);
        if (Array.isArray(parsed) && parsed.length > 0) {
          entitiesStr = parsed.join(', ');
        }
      } catch {
        entitiesStr = episode.entities;
      }
    }

    // Format date
    const date = new Date(episode.created_at);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    // Format output
    const output = [
      `## Memory: ${episode.summary}`,
      `**Date:** ${dateStr}`,
      `**Project:** ${episode.project || 'Global'}`,
      `**Importance:** ${episode.importance}`,
      '',
      `**Summary:** ${episode.summary}`,
      '',
      `**Full Context:**`,
      episode.full_content || '(No additional context available)',
      '',
      `**Related Entities:** ${entitiesStr}`,
    ].join('\n');

    return {
      content: [{ type: 'text' as const, text: output }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory expand failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_forget
// ---------------------------------------------------------------------------

async function handleMemoryForget(args: { id: string }) {
  const { id } = args;

  try {
    // Validate ID format
    if (!id || !id.startsWith('ep_')) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Invalid episode ID. Must start with "ep_" (e.g. "ep_abc123").',
          },
        ],
        isError: true,
      };
    }

    // W3: Check episode exists AND enforce scope/project boundary
    const episode = db
      .prepare('SELECT id, summary, scope, project FROM episodes WHERE id = ?')
      .get(id) as { id: string; summary: string; scope: string; project: string | null } | undefined;

    if (!episode) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No memory found with ID: ${id}`,
          },
        ],
      };
    }

    // W3 + C3: Scope/project boundary check — only allow deleting episodes
    // that are global or belong to the current project.
    // NOTE (C3): Comparison uses project basename only (episodes table stores basename).
    // Two repos with identical basenames could theoretically cross-delete. A full fix
    // requires a schema migration to store canonical project paths. Low practical risk
    // since project names are typically unique within a user's workspace.
    if (episode.scope === 'project' && episode.project) {
      const currentProject = detectProject();
      if (!currentProject || currentProject.name !== episode.project) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Cannot delete memory from project "${episode.project}" — not the current project.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Delete the episode — the `episodes_ad` trigger in schema.ts
    // automatically handles FTS5 cleanup on DELETE.
    // Do NOT manually delete from episodes_fts.
    db.prepare('DELETE FROM episodes WHERE id = ?').run(id);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Deleted memory: "${episode.summary}" (${id})`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory forget failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool: memory_status
// ---------------------------------------------------------------------------

async function handleMemoryStatus() {
  try {
    const memoryDir = path.join(os.homedir(), '.claude-memory');
    const pidPath = path.join(memoryDir, 'engram.pid');
    const recollectionsDir = path.join(memoryDir, 'recollections');

    // 1. Daemon health — check PID file and process liveness
    let daemonStatus = 'NOT RUNNING';
    let daemonPid: number | null = null;
    let daemonUptime: string | null = null;

    try {
      const pidStr = await fs.readFile(pidPath, 'utf-8');
      daemonPid = parseInt(pidStr.trim(), 10);
      if (!isNaN(daemonPid)) {
        try {
          process.kill(daemonPid, 0); // signal 0 = check alive
          daemonStatus = `RUNNING (PID ${daemonPid})`;

          // Calculate uptime from PID file mtime
          const stat = await fs.stat(pidPath);
          const uptimeMs = Date.now() - stat.mtimeMs;
          const hours = Math.floor(uptimeMs / 3_600_000);
          const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);
          daemonUptime = `${hours}h ${mins}m`;
        } catch {
          daemonStatus = `NOT RUNNING (stale PID: ${daemonPid})`;
        }
      }
    } catch {
      // PID file doesn't exist
    }

    // 1b. Check if UDS socket exists on disk
    let socketExists = false;
    try {
      await fs.access(SOCKET_PATH);
      socketExists = true;
    } catch {}

    // 2. Episode counts — total, by project, by importance
    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM episodes').get() as { cnt: number };
    const total = totalRow.cnt;

    const byProject = db.prepare(`
      SELECT COALESCE(project, '(global)') as proj, COUNT(*) as cnt
      FROM episodes GROUP BY project ORDER BY cnt DESC
    `).all() as { proj: string; cnt: number }[];

    const byImportance = db.prepare(`
      SELECT importance, COUNT(*) as cnt
      FROM episodes GROUP BY importance ORDER BY cnt DESC
    `).all() as { importance: string; cnt: number }[];

    // 3. Chunk count
    const chunkRow = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as { cnt: number };
    const chunkCount = chunkRow.cnt;

    // 4. Recollections directory
    let recollectionCount = 0;
    try {
      const files = await fs.readdir(recollectionsDir);
      recollectionCount = files.filter(f => f.endsWith('.json')).length;
    } catch {
      // Directory may not exist
    }

    // 5. Schema version
    let schemaVersion = 0;
    try {
      const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (row) schemaVersion = parseInt(row.value, 10);
    } catch {
      // _meta table may not exist
    }

    // 6. Format output
    const lines: string[] = [
      '=== Engram Status ===',
      '',
      `Daemon:       ${daemonStatus}`,
    ];
    if (daemonUptime) {
      lines.push(`Uptime:       ${daemonUptime}`);
    }
    lines.push(`Socket:       ${socketExists ? 'exists' : 'NOT FOUND'} (${SOCKET_PATH})`);
    lines.push(`Schema:       v${schemaVersion}`);
    lines.push(`DB Path:      ${DB_PATH}`);
    lines.push('');
    lines.push(`Episodes:     ${total} total`);
    if (byProject.length > 0) {
      for (const p of byProject) {
        lines.push(`  ${p.proj.padEnd(25)} ${p.cnt}`);
      }
    }
    lines.push('');
    lines.push('By importance:');
    if (byImportance.length > 0) {
      for (const i of byImportance) {
        lines.push(`  ${i.importance.padEnd(10)} ${i.cnt}`);
      }
    }
    lines.push('');
    lines.push(`Chunks:       ${chunkCount}`);
    lines.push(`Recollections: ${recollectionCount} active`);

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Memory status failed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Cache discovered project memory dirs once at startup (watcher handles new dirs)
  cachedProjectMemoryDirs = discoverProjectMemoryDirs();

  // Start file watcher
  startWatcher(db, provider, recentlySaved);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Schedule backfill after event loop yields so it doesn't delay startup
  setImmediate(async () => {
    try {
      await backfillEmbeddings(db, provider);
    } catch (err) {
      console.error('[claude-memory] Backfill error:', (err as Error).message);
    }
  });

  console.error('[claude-memory] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[claude-memory] Fatal error:', err);
  process.exit(1);
});
