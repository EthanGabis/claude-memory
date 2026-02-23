import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { withFileLock } from '../shared/file-lock.js';

const GLOBAL_MEMORY_PATH = path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
const GRADUATION_MIN_ACCESS = 3;
const COMPRESS_AGE_DAYS = 30;
const COMPRESS_MAX_ACCESS = 1;
const MAX_GRADUATED_PER_CYCLE = 10;

interface GraduationCandidate {
  id: string;
  summary: string;
  full_content: string | null;
  entities: string | null;
  importance: string;
  project: string | null;
  scope: string;
  access_count: number;
  created_at: number;
}

interface CompressCandidate {
  id: string;
  summary: string;
  access_count: number;
  created_at: number;
  accessed_at: number;
}

export async function runConsolidation(db: Database): Promise<{
  graduated: number;
  compressed: number;
}> {
  const graduated = await graduateEpisodes(db);
  const compressed = await compressStaleEpisodes(db);
  return { graduated, compressed };
}

async function graduateEpisodes(db: Database): Promise<number> {
  const candidates = db.prepare(`
    SELECT id, summary, full_content, entities, importance, project, scope, access_count, created_at
    FROM episodes
    WHERE importance = 'high'
      AND access_count >= ?
      AND graduated_at IS NULL
    ORDER BY access_count DESC, created_at DESC
    LIMIT ?
  `).all(GRADUATION_MIN_ACCESS, MAX_GRADUATED_PER_CYCLE * 2) as GraduationCandidate[];

  if (candidates.length === 0) return 0;

  const markGraduated = db.prepare('UPDATE episodes SET graduated_at = ? WHERE id = ?');

  return withFileLock(GLOBAL_MEMORY_PATH + '.lock', async () => {
    let existing = '';
    try {
      existing = await fs.readFile(GLOBAL_MEMORY_PATH, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    let graduated = 0;
    let newContent = existing;
    const graduatedIds: { id: string }[] = [];

    for (const candidate of candidates) {
      if (graduated >= MAX_GRADUATED_PER_CYCLE) break;

      const date = new Date(candidate.created_at).toISOString().split('T')[0];
      const projectTag = candidate.project ? ` (project: ${candidate.project})` : '';
      const entitiesStr = candidate.entities ? ` [${candidate.entities}]` : '';
      const entry = `\n## ${date}\n${candidate.summary}${projectTag}${entitiesStr}\n`;

      // Dedup on full formatted entry, not raw summary
      if (newContent.includes(entry.trim())) continue;

      newContent += entry;
      graduatedIds.push({ id: candidate.id });
      graduated++;
    }

    if (graduated > 0) {
      await fs.mkdir(path.dirname(GLOBAL_MEMORY_PATH), { recursive: true });
      // Atomic write: temp + rename (matching server.ts safety pattern)
      const tmpPath = GLOBAL_MEMORY_PATH + '.tmp';
      await fs.writeFile(tmpPath, newContent, 'utf-8');
      await fs.rename(tmpPath, GLOBAL_MEMORY_PATH);

      // Mark graduated episodes so they aren't re-queried
      const now = Date.now();
      for (const { id } of graduatedIds) {
        markGraduated.run(now, id);
      }
    }

    return graduated;
  });
}

async function compressStaleEpisodes(db: Database): Promise<number> {
  const cutoff = Date.now() - COMPRESS_AGE_DAYS * 86_400_000;

  const stale = db.prepare(`
    SELECT id, summary, access_count, created_at, accessed_at
    FROM episodes
    WHERE created_at < ?
      AND access_count <= ?
      AND importance = 'normal'
    ORDER BY created_at ASC
  `).all(cutoff, COMPRESS_MAX_ACCESS) as CompressCandidate[];

  if (stale.length === 0) return 0;

  const compressStmt = db.prepare(
    'UPDATE episodes SET full_content = NULL WHERE id = ?'
  );

  let compressed = 0;
  for (const episode of stale) {
    compressStmt.run(episode.id);
    compressed++;
  }

  return compressed;
}
