import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { initDb, DB_PATH } from './schema.js';
import { packEmbedding, cosineSimilarity } from './embeddings.js';
import { search } from './search.js';
import { indexFile, backfillEmbeddings } from './indexer.js';
import { createProviderChain } from './providers.js';
import { startWatcher, discoverProjectMemoryDirs } from './watcher.js';
import { withFileLock } from '../shared/file-lock.js';
// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('[claude-memory] OPENAI_API_KEY is not set. Local GGUF provider will be used if available; falling back to BM25-only search.');
}
const db = initDb(DB_PATH);
// Tracks paths recently written by memory_save to suppress watcher double-index
const recentlySaved = new Set();
// Cached project memory dirs discovered at startup (avoids synchronous walk on every request)
let cachedProjectMemoryDirs = [];
// Initialize embedding provider chain (local GGUF -> OpenAI -> BM25-only)
const provider = createProviderChain(apiKey, db);
// ---------------------------------------------------------------------------
// Project detection — walk up from CWD looking for .claude/ directory
// ---------------------------------------------------------------------------
function detectProject(startDir) {
    let dir = startDir ?? process.cwd();
    const root = path.parse(dir).root;
    while (dir !== root) {
        const claudeDir = path.join(dir, '.claude');
        try {
            const stat = fsSync.statSync(claudeDir);
            if (stat.isDirectory()) {
                return { root: dir, name: path.basename(dir) };
            }
        }
        catch {
            // .claude/ not found at this level — keep walking up
        }
        dir = path.dirname(dir);
    }
    return null;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatResults(results) {
    if (results.length === 0)
        return 'No results found.';
    return results
        .map((r, i) => {
        const lines = r.startLine === r.endLine
            ? `L${r.startLine}`
            : `L${r.startLine}-${r.endLine}`;
        const score = r.score.toFixed(3);
        const snippet = r.text.length > 500 ? r.text.slice(0, 500) + '...' : r.text;
        return `[${i + 1}] ${r.path} (${lines}) — score ${score}\n${snippet}`;
    })
        .join('\n\n---\n\n');
}
function todayString() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server({ name: 'claude-memory', version: '0.1.0' }, { capabilities: { tools: {} } });
// -- List tools -----------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'memory_search',
            description: 'Search memory (daily logs and MEMORY.md files) using hybrid BM25 + vector search with temporal decay. Returns ranked results with file path, line range, score, and text snippet.',
            inputSchema: {
                type: 'object',
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
                        description: 'Filter results to a specific project name. Omit to search all layers.',
                    },
                },
                required: ['query'],
            },
        },
        {
            name: 'memory_get',
            description: 'Read a specific memory file by path. Returns text content, resolved path, and whether content was truncated. Returns empty text (no error) if file does not exist.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Workspace-relative path (e.g. "MEMORY.md" or "memory/2026-02-21.md")',
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
            description: 'Save content to memory. target="log" (default) appends to today\'s daily log. target="memory" appends to MEMORY.md with dedup check.',
            inputSchema: {
                type: 'object',
                properties: {
                    content: {
                        type: 'string',
                        description: 'The content to save',
                    },
                    target: {
                        type: 'string',
                        enum: ['log', 'memory'],
                        description: 'Where to save: "log" for daily log (default), "memory" for MEMORY.md',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Optional working directory path to use for project detection instead of the server process CWD',
                    },
                },
                required: ['content'],
            },
        },
        {
            name: 'memory_recall',
            description: "Get brief memory recollections for a topic. Returns short 'memory bites' that you can expand with memory_expand(). Use this when you want to check what you remember about a topic.",
            inputSchema: {
                type: 'object',
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
                        description: 'Filter results to a specific project name. Omit to search all scopes.',
                    },
                },
                required: ['query'],
            },
        },
        {
            name: 'memory_expand',
            description: 'Expand a memory recollection to get full context. Pass the episode ID from memory_recall results.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'The episode ID from memory_recall results (e.g. "ep_abc123")',
                    },
                },
                required: ['id'],
            },
        },
    ],
}));
// -- Call tool -------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'memory_search') {
        return handleMemorySearch(args);
    }
    if (name === 'memory_get') {
        return handleMemoryGet(args);
    }
    if (name === 'memory_save') {
        return handleMemorySave(args);
    }
    if (name === 'memory_recall') {
        return handleMemoryRecall(args);
    }
    if (name === 'memory_expand') {
        return handleMemoryExpand(args);
    }
    return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
    };
});
// ---------------------------------------------------------------------------
// Tool: memory_search
// ---------------------------------------------------------------------------
async function handleMemorySearch(args) {
    const { query, limit, project } = args;
    const effectiveLimit = Math.max(1, Math.min(limit ?? 10, 50));
    try {
        const embeddingResults = await provider.embed([query]);
        const queryVec = embeddingResults[0];
        let queryEmbedding;
        if (queryVec) {
            queryEmbedding = packEmbedding(queryVec);
        }
        else {
            // BM25-only fallback: zero vector (search.ts handles zero-vector gracefully)
            queryEmbedding = packEmbedding(new Float32Array(768));
        }
        const results = search(db, queryEmbedding, query, effectiveLimit, project);
        const formatted = formatResults(results);
        return {
            content: [{ type: 'text', text: formatted }],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Search failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
}
// ---------------------------------------------------------------------------
// Tool: memory_get
// ---------------------------------------------------------------------------
async function handleMemoryGet(args) {
    if (!args.path || args.path.trim() === '') {
        return {
            content: [{ type: 'text', text: 'Access denied: path must not be empty' }],
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
    let resolvedPath = null; // first security-valid candidate (fallback)
    let resolvedPathExists = null; // first candidate that exists on disk
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
            }
            catch {
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
                    type: 'text',
                    text: 'Access denied: path is outside allowed memory directories',
                },
            ],
            isError: true,
        };
    }
    // Read file — return empty on ENOENT, never throw
    let content;
    try {
        content = await fs.readFile(effectivePath, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ text: '', path: effectivePath, truncated: false }),
                    },
                ],
            };
        }
        if (err.code === 'EISDIR') {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Access denied: path resolves to a directory, not a file',
                    },
                ],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: 'text',
                    text: `Read failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
    // Validate line parameters
    if (startLine !== undefined && startLine < 1) {
        return {
            content: [{ type: 'text', text: 'startLine must be >= 1' }],
            isError: true,
        };
    }
    if (lineCount !== undefined && lineCount < 1) {
        return {
            content: [{ type: 'text', text: 'lineCount must be >= 1' }],
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
    if (truncated)
        content = content.slice(0, MAX_CHARS);
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({ text: content, path: effectivePath, truncated }),
            },
        ],
    };
}
// ---------------------------------------------------------------------------
// Tool: memory_save
// ---------------------------------------------------------------------------
async function handleMemorySave(args) {
    const { content, target = 'log' } = args;
    const project = detectProject(args.cwd);
    try {
        if (target === 'log') {
            return await saveToLog(content, project);
        }
        else {
            return await saveToMemory(content, project);
        }
    }
    catch (err) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Save failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
}
async function saveToLog(content, project) {
    const today = todayString();
    let logPath;
    let layer;
    let projectName;
    if (project) {
        logPath = path.join(project.root, '.claude', 'memory', `${today}.md`);
        layer = 'project';
        projectName = project.name;
    }
    else {
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
                type: 'text',
                text: `Saved to daily log: ${logPath}`,
            },
        ],
    };
}
async function saveToMemory(content, project) {
    let memoryPath;
    let layer;
    let projectName;
    if (project) {
        memoryPath = path.join(project.root, '.claude', 'memory', 'MEMORY.md');
        layer = 'project';
        projectName = project.name;
    }
    else {
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
        }
        catch {
            // File doesn't exist yet — will be created
        }
        // Simple substring dedup: check if the content is already present
        if (existing.includes(content.trim())) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Content already recorded in ${memoryPath} — skipped.`,
                    },
                ],
            };
        }
        // Build the new entry and rewrite the whole file (never blind-append)
        const timestamp = new Date().toISOString();
        const entry = `\n## ${timestamp}\n${content}\n`;
        const newContent = existing + entry;
        await fs.writeFile(memoryPath, newContent, 'utf-8');
        return null; // success — continue with indexing outside the lock
    });
    if (result)
        return result; // dedup short-circuit
    // Mark path as recently saved BEFORE indexing so concurrent searches see the dedup flag
    recentlySaved.add(memoryPath);
    setTimeout(() => recentlySaved.delete(memoryPath), 3000);
    // Re-index the file (outside the lock — indexing doesn't need it)
    await indexFile(db, memoryPath, layer, projectName, provider);
    return {
        content: [
            {
                type: 'text',
                text: `Saved to MEMORY.md: ${memoryPath}`,
            },
        ],
    };
}
async function handleMemoryRecall(args) {
    const { query, limit, project } = args;
    const effectiveLimit = Math.max(1, Math.min(limit ?? 5, 50));
    try {
        // 1. Embed query using provider chain
        const embeddingResults = await provider.embed([query]);
        const queryVec = embeddingResults[0];
        let queryEmbedding;
        if (queryVec) {
            queryEmbedding = packEmbedding(queryVec);
        }
        else {
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
        let bm25Rows = [];
        try {
            bm25Rows = db
                .prepare('SELECT rowid, bm25(episodes_fts) as score FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY bm25(episodes_fts) LIMIT ?')
                .all(ftsQuery, candidateCount);
        }
        catch {
            // FTS may fail on empty or invalid query — fall back to vector-only
        }
        // 3. Collect candidate episodes (BM25 hits + vector scan for broader coverage)
        const candidateMap = new Map();
        // BM25 candidates
        const episodeByRowid = project
            ? db.prepare('SELECT *, rowid FROM episodes WHERE rowid = ? AND (scope = \'global\' OR project = ?)')
            : db.prepare('SELECT *, rowid FROM episodes WHERE rowid = ?');
        for (const row of bm25Rows) {
            const episode = (project
                ? episodeByRowid.get(row.rowid, project)
                : episodeByRowid.get(row.rowid));
            if (episode) {
                candidateMap.set(episode.id, { episode, rawBM25: row.score });
            }
        }
        // Also fetch recent episodes with embeddings for vector-only matches
        const recentEpisodes = (project
            ? db.prepare('SELECT *, rowid FROM episodes WHERE embedding IS NOT NULL AND (scope = \'global\' OR project = ?) ORDER BY created_at DESC LIMIT ?').all(project, candidateCount)
            : db.prepare('SELECT *, rowid FROM episodes WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT ?').all(candidateCount));
        for (const ep of recentEpisodes) {
            if (!candidateMap.has(ep.id)) {
                candidateMap.set(ep.id, { episode: ep, rawBM25: 0 });
            }
        }
        if (candidateMap.size === 0) {
            return {
                content: [{ type: 'text', text: 'No memories found for that topic.' }],
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
        const scored = candidates.map((c) => {
            // Vector similarity
            let vectorScore = 0;
            if (c.episode.embedding) {
                vectorScore = cosineSimilarity(queryEmbedding, c.episode.embedding);
            }
            // Normalized BM25 — only episodes with a real BM25 hit participate
            let bm25Score = 0;
            if (c.rawBM25 !== 0) {
                if (bm25Min === bm25Max) {
                    bm25Score = 1.0; // Single hit gets full BM25 score
                }
                else {
                    bm25Score = (c.rawBM25 - bm25Max) / (bm25Min - bm25Max);
                }
            }
            // Combined relevance (same weighting as search.ts)
            const relevance = 0.7 * vectorScore + 0.3 * bm25Score;
            // Recency: exponential decay, 30-day half-life
            const ageInDays = (now - c.episode.created_at) / 86_400_000;
            const recency = Math.exp(-(Math.LN2 / 30) * ageInDays);
            // Access frequency: normalized 0..1
            const accessFreq = c.episode.access_count / maxAccess;
            // High-importance memories get minimum relevance floor of 0.3
            const effectiveRelevance = (c.episode.importance === 'high') ? Math.max(relevance, 0.3) : relevance;
            // Final score: 0.5*relevance + 0.3*recency + 0.2*accessFrequency
            const finalScore = 0.5 * effectiveRelevance + 0.3 * recency + 0.2 * accessFreq;
            return { episode: c.episode, score: finalScore };
        });
        // Sort by score descending and take top results
        scored.sort((a, b) => b.score - a.score);
        const topResults = scored.slice(0, effectiveLimit);
        // 5. Update accessed_at and access_count for returned episodes
        const updateStmt = db.prepare('UPDATE episodes SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?');
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
                    type: 'text',
                    text: topResults.length > 0
                        ? formatted
                        : 'No memories found for that topic.',
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory recall failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
}
// ---------------------------------------------------------------------------
// Tool: memory_expand
// ---------------------------------------------------------------------------
async function handleMemoryExpand(args) {
    const { id } = args;
    try {
        const episode = db
            .prepare('SELECT * FROM episodes WHERE id = ?')
            .get(id);
        if (!episode) {
            return {
                content: [{ type: 'text', text: 'No memory found with that ID.' }],
            };
        }
        // Update accessed_at and access_count
        const now = Date.now();
        db.prepare('UPDATE episodes SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?').run(now, id);
        // Format entities
        let entitiesStr = 'None';
        if (episode.entities) {
            try {
                const parsed = JSON.parse(episode.entities);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    entitiesStr = parsed.join(', ');
                }
            }
            catch {
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
            content: [{ type: 'text', text: output }],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: 'text',
                    text: `Memory expand failed: ${err.message}`,
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
        }
        catch (err) {
            console.error('[claude-memory] Backfill error:', err.message);
        }
    });
    console.error('[claude-memory] MCP server running on stdio');
}
main().catch((err) => {
    console.error('[claude-memory] Fatal error:', err);
    process.exit(1);
});
