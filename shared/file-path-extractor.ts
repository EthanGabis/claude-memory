import fs from 'node:fs';
import path from 'node:path';

/**
 * Extract absolute file paths from raw text content (e.g. observed session blocks).
 * Handles JSON-like key-value patterns and standalone /Users/ paths.
 */
export function extractFilePathsFromText(text: string): string[] {
  const paths = new Set<string>();

  // Pattern 1: JSON key-value pairs like "file_path":"/Users/foo/bar.ts"
  const jsonKeyRegex = /"(?:file_path|path|file|notebook_path)"\s*:\s*"(\/[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = jsonKeyRegex.exec(text)) !== null) {
    const p = match[1];
    if (path.isAbsolute(p)) {
      paths.add(p);
    }
  }

  // Pattern 2: Fallback — any absolute path starting with /Users/
  const absolutePathRegex = /\/Users\/[^\s"',}\]\)]+/g;
  while ((match = absolutePathRegex.exec(text)) !== null) {
    const cleaned = match[0].replace(/[.:;]+$/, '');
    if (path.isAbsolute(cleaned)) {
      paths.add(cleaned);
    }
  }

  return [...paths];
}

const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write']);
const DIR_PATH_TOOLS = new Set(['Grep']);
const GLOB_TOOL = 'Glob';

/**
 * Extract file paths from a single JSONL entry's assistant message content.
 */
export function extractFilePathsFromEntry(entry: any): string[] {
  const paths: string[] = [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return paths;

  for (const block of content) {
    if (block?.type !== 'tool_use' || !block.input) continue;
    const name = block.name;

    // Read/Edit/Write -> input.file_path
    if (FILE_PATH_TOOLS.has(name)) {
      const fp = block.input.file_path;
      if (typeof fp === 'string' && path.isAbsolute(fp)) {
        paths.push(fp);
      }
      continue;
    }

    // Grep -> input.path
    if (DIR_PATH_TOOLS.has(name)) {
      const p = block.input.path;
      if (typeof p === 'string' && path.isAbsolute(p)) {
        paths.push(p);
      }
      continue;
    }

    // Glob -> input.path OR absolute prefix in input.pattern
    if (name === GLOB_TOOL) {
      const p = block.input.path;
      if (typeof p === 'string' && path.isAbsolute(p)) {
        paths.push(p);
      }
      // Also check pattern for absolute prefix (e.g. "/Users/foo/bar/**/*.ts")
      const pattern = block.input.pattern;
      if (typeof pattern === 'string' && path.isAbsolute(pattern)) {
        // Extract the non-glob prefix
        const globStart = pattern.search(/[*?[\{]/);
        if (globStart > 0) {
          const prefix = pattern.slice(0, globStart);
          // Ensure it ends at a directory boundary
          const dirPrefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : prefix;
          if (dirPrefix && path.isAbsolute(dirPrefix)) {
            paths.push(dirPrefix);
          }
        }
      }
      continue;
    }
  }

  return paths;
}

/**
 * Extract file paths from a JSONL file (including file-history-snapshot on line 1).
 * Reads synchronously for use in resolver (which is sync).
 */
export function extractFilePathsFromJsonl(jsonlPath: string, maxLines: number = 200, maxBytes: number = 512 * 1024): string[] {
  const allPaths = new Set<string>();

  let fd: number | null = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const CHUNK_SIZE = 16384;
    const MAX_BYTES = maxBytes;
    let accumulated = '';
    let offset = 0;
    let linesScanned = 0;

    while (offset < MAX_BYTES && linesScanned < maxLines) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      accumulated += buf.toString('utf-8', 0, bytesRead);
      offset += bytesRead;

      let newlineIdx: number;
      while ((newlineIdx = accumulated.indexOf('\n')) >= 0 && linesScanned < maxLines) {
        const line = accumulated.slice(0, newlineIdx);
        accumulated = accumulated.slice(newlineIdx + 1);
        linesScanned++;

        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Line 1: file-history-snapshot -> trackedFileBackups keys
          if (linesScanned === 1 && entry?.type === 'file-history-snapshot') {
            const backups = entry?.snapshot?.trackedFileBackups;
            if (backups && typeof backups === 'object') {
              for (const key of Object.keys(backups)) {
                if (path.isAbsolute(key)) {
                  allPaths.add(key);
                }
              }
            }
            continue;
          }

          // All other lines: extract from tool_use blocks
          const extracted = extractFilePathsFromEntry(entry);
          for (const p of extracted) {
            allPaths.add(p);
          }

          // Fallback: scan raw text for file paths (observer sessions embed
          // tool_use as plain text in <observed_from_primary_session> blocks)
          if (extracted.length === 0) {
            const textPaths = extractFilePathsFromText(line);
            for (const p of textPaths) {
              allPaths.add(p);
            }
          }
        } catch {
          // Malformed line -- skip
        }
      }
    }
  } catch {
    // File read error -- return whatever we have
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return [...allPaths];
}

const MAX_SUBAGENT_FILES = 10;

/**
 * Extract file paths from a full session: the main JSONL plus any subagent JSONLs.
 *
 * Lead/orchestrator sessions delegate file work to subagents whose Read/Edit/Write
 * calls live in separate JSONL files under `<sessionId>/subagents/*.jsonl`.
 *
 * This function:
 * 1. Scans the main session JSONL via extractFilePathsFromJsonl
 * 2. Checks for a sibling directory named after the session ID
 * 3. If found, scans subagents/*.jsonl files inside it (capped at 10 files)
 * 4. Returns a deduplicated merged array of all discovered paths
 *
 * Intended for migration/cold paths only — not the live resolver hot path.
 */
export function extractFilePathsFromSession(jsonlPath: string, maxLines?: number, maxBytes: number = 5 * 1024 * 1024): string[] {
  const allPaths = new Set<string>();

  // 1. Scan the main session JSONL (with higher byte cap for cold migration)
  const mainPaths = extractFilePathsFromJsonl(jsonlPath, maxLines, maxBytes);
  for (const p of mainPaths) {
    allPaths.add(p);
  }

  // 2. Derive the sibling directory path from the JSONL filename
  //    e.g. /path/to/f9a1016c-61b9-41b7-bb58-f080309f0223.jsonl
  //      -> /path/to/f9a1016c-61b9-41b7-bb58-f080309f0223/
  const dir = path.dirname(jsonlPath);
  const basename = path.basename(jsonlPath, '.jsonl');
  const sessionDir = path.join(dir, basename);

  // 3. Check if the session directory and subagents subdirectory exist
  const subagentsDir = path.join(sessionDir, 'subagents');
  try {
    const stat = fs.statSync(subagentsDir);
    if (!stat.isDirectory()) return [...allPaths];
  } catch {
    // Directory doesn't exist — no subagents to scan
    return [...allPaths];
  }

  // 4. Read subagent JSONL files, capped at MAX_SUBAGENT_FILES
  try {
    const entries = fs.readdirSync(subagentsDir);
    let scanned = 0;

    for (const entry of entries) {
      if (scanned >= MAX_SUBAGENT_FILES) break;
      if (!entry.endsWith('.jsonl')) continue;

      const subagentPath = path.join(subagentsDir, entry);
      try {
        const stat = fs.statSync(subagentPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const subPaths = extractFilePathsFromJsonl(subagentPath, maxLines, maxBytes);
      for (const p of subPaths) {
        allPaths.add(p);
      }
      scanned++;
    }
  } catch {
    // readdir error — return whatever we have
  }

  return [...allPaths];
}
