import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import type OpenAI from 'openai';
import { withFileLock } from '../shared/file-lock.js';
import { runBeliefConsolidation } from './belief-consolidator.js';

const GLOBAL_MEMORY_PATH = path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
const GRADUATION_MIN_ACCESS = 3;
const COMPRESS_AGE_DAYS = 30;
const COMPRESS_MAX_ACCESS = 0;
const MAX_GRADUATED_PER_CYCLE = 10;
const MAX_MEMORY_LINES = 200;

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

export async function runConsolidation(
  db: Database,
  openai?: OpenAI | null,
  embedProvider?: { embed(texts: string[]): Promise<(Float32Array | null)[]> } | null,
): Promise<{
  graduated: number;
  compressed: number;
}> {
  const graduated = await graduateEpisodes(db);
  const compressed = await compressStaleEpisodes(db);

  // Run belief consolidation if LLM client and embed provider are available
  if (openai && embedProvider) {
    try {
      await runBeliefConsolidation(db, openai, embedProvider);
    } catch (err) {
      console.error(`[consolidator] Belief consolidation failed: ${(err as Error).message}`);
    }
  }

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

  // Time-based graduation: high-importance episodes older than 14 days
  // graduate regardless of access count (prevents cold-start knowledge loss)
  const TIME_GRADUATION_DAYS = 14;
  const timeBasedCandidates = db.prepare(`
    SELECT id, summary, full_content, entities, importance, project, scope, access_count, created_at
    FROM episodes
    WHERE importance = 'high'
      AND graduated_at IS NULL
      AND scope = 'global'
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(
    Date.now() - TIME_GRADUATION_DAYS * 86_400_000,
    MAX_GRADUATED_PER_CYCLE
  ) as GraduationCandidate[];

  // Merge: access-based first, then time-based (dedup by id)
  const seenIds = new Set(candidates.map(c => c.id));
  for (const tc of timeBasedCandidates) {
    if (!seenIds.has(tc.id)) {
      candidates.push(tc);
      seenIds.add(tc.id);
    }
  }

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
      // Fix #10: Use stable ID marker for dedup (prevents false positives from substring matches)
      const idMarker = `<!-- ${candidate.id} -->`;
      const entry = `\n## ${date}\n${idMarker}\n${candidate.summary}${projectTag}${entitiesStr}\n`;

      if (newContent.includes(idMarker)) {
        // W5: Already in MEMORY.md — mark graduated to prevent re-querying every cycle
        graduatedIds.push({ id: candidate.id });
        continue;
      }

      newContent += entry;
      graduatedIds.push({ id: candidate.id });
      graduated++;
    }

    // Size cap: archive oldest sections if MEMORY.md exceeds MAX_MEMORY_LINES
    const lines = newContent.split('\n');
    if (lines.length > MAX_MEMORY_LINES) {
      // Split on section boundaries (## headers)
      const sections = newContent.split(/(?=^## )/m);
      let archiveSections: string[] = [];
      let remainingSections = [...sections];

      // Preserve preamble (non-## content before first section header)
      let preamble = '';
      if (remainingSections.length > 0 && !remainingSections[0].startsWith('## ')) {
        preamble = remainingSections.shift()!;
      }

      // Remove oldest sections (from the start) until under the limit
      while (
        (preamble + remainingSections.join('')).split('\n').length > MAX_MEMORY_LINES &&
        remainingSections.length > 1
      ) {
        archiveSections.push(remainingSections.shift()!);
      }

      if (archiveSections.length > 0) {
        // Write archived sections to monthly archive file
        const now = new Date();
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const archiveDir = path.join(path.dirname(GLOBAL_MEMORY_PATH), 'archive');
        const archivePath = path.join(archiveDir, `${yearMonth}.md`);

        await fs.mkdir(archiveDir, { recursive: true });
        await fs.appendFile(archivePath, archiveSections.join('') + '\n', 'utf-8');

        console.error(`[consolidator] Archived ${archiveSections.length} sections to ${archivePath}`);
        newContent = preamble + remainingSections.join('');
      }
    }

    if (graduated > 0) {
      await fs.mkdir(path.dirname(GLOBAL_MEMORY_PATH), { recursive: true });
      // Atomic write: temp + rename (matching server.ts safety pattern)
      const tmpPath = GLOBAL_MEMORY_PATH + '.tmp.' + process.pid;
      await fs.writeFile(tmpPath, newContent, 'utf-8');
      await fs.rename(tmpPath, GLOBAL_MEMORY_PATH);
    }

    // W1: Mark ALL graduated/deduped episodes (including already-present ones)
    // outside the `graduated > 0` guard so duplicates are also marked
    if (graduatedIds.length > 0) {
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

  // W7: Skip rows where full_content is already NULL to avoid unnecessary writes
  const stale = db.prepare(`
    SELECT id, summary, access_count, created_at, accessed_at
    FROM episodes
    WHERE created_at < ?
      AND access_count <= ?
      AND importance = 'normal'
      AND full_content IS NOT NULL
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
