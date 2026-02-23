import fs from 'node:fs';
import path from 'node:path';

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
export function extractFilePathsFromJsonl(jsonlPath: string, maxLines: number = 200): string[] {
  const allPaths = new Set<string>();

  let fd: number | null = null;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const CHUNK_SIZE = 16384;
    const MAX_BYTES = 512 * 1024; // 512KB cap
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
