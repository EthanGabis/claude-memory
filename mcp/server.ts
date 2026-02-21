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
import { embedText } from './embeddings.js';
import { search, type SearchResult } from './search.js';
import { indexFile } from './indexer.js';

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    '[claude-memory] OPENAI_API_KEY is not set. Set it in your environment before starting the server.',
  );
  process.exit(1);
}

const db = initDb(DB_PATH);

// ---------------------------------------------------------------------------
// Project detection — walk up from CWD looking for .claude/ directory
// ---------------------------------------------------------------------------

function detectProject(startDir?: string): { root: string; name: string } | null {
  let dir = startDir ?? process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const claudeDir = path.join(dir, '.claude');
    try {
      const stat = fsSync.statSync(claudeDir);
      if (stat.isDirectory()) {
        return { root: dir, name: path.basename(dir) };
      }
    } catch {
      // .claude/ not found at this level — keep walking up
    }
    dir = path.dirname(dir);
  }

  return null;
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
  ],
}));

// -- Call tool -------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'memory_search') {
    return handleMemorySearch(args as { query: string; limit?: number; project?: string });
  }

  if (name === 'memory_save') {
    return handleMemorySave(args as { content: string; target?: 'log' | 'memory'; cwd?: string });
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
  const { query, limit = 10, project } = args;

  try {
    const queryEmbedding = await embedText(db, query, apiKey!);
    const results = search(db, queryEmbedding, query, limit, project);
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
  await fs.appendFile(logPath, entry, 'utf-8');

  // Re-index the file
  indexFile(db, logPath, layer, projectName);

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
  await fs.writeFile(memoryPath, newContent, 'utf-8');

  // Re-index the file
  indexFile(db, memoryPath, layer, projectName);

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
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[claude-memory] MCP server running on stdio');
}

main().catch((err) => {
  console.error('[claude-memory] Fatal error:', err);
  process.exit(1);
});
