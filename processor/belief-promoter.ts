// processor/belief-promoter.ts — Promote high-confidence beliefs to MEMORY.md

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Database } from 'bun:sqlite';
import { withFileLock } from '../shared/file-lock.js';
import { beliefConfidence } from './belief-utils.js';

export const BEGIN_MARKER = '<!-- ENGRAM:BELIEFS:BEGIN -->';
export const END_MARKER = '<!-- ENGRAM:BELIEFS:END -->';
const MAX_ACTIVE_BELIEFS = 10;
const MAX_FORMER_BELIEFS = 5;
const PROMOTE_CONFIDENCE = 0.7;
const PROMOTE_MIN_EVIDENCE = 3;
const REMOVE_CONFIDENCE = 0.5;
const DEMOTE_EXPIRY_DAYS = 30;

interface PromotionResult {
  promoted: number;
  demoted: number;
  removed: number;
}

interface BeliefRow {
  id: string;
  statement: string;
  confidence_alpha: number;
  confidence_beta: number;
  evidence_count: number;
  status: string;
  scope: string;
  project_path: string | null;
  promoted_at: number | null;
  demoted_at: number | null;
  peak_confidence: number | null;
}

function resolveMemoryPath(projectPath: string | null): string {
  if (projectPath) {
    return path.join(projectPath, '.claude', 'memory', 'MEMORY.md');
  }
  return path.join(os.homedir(), '.claude-memory', 'MEMORY.md');
}

function parseMarkerSection(content: string): { before: string; section: string; after: string } {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = content.slice(0, beginIdx);
    const section = content.slice(beginIdx, endIdx + END_MARKER.length);
    const after = content.slice(endIdx + END_MARKER.length);
    return { before, section, after };
  }

  // Markers missing or corrupted — place new section at top
  return { before: '', section: '', after: content };
}

function formatBeliefsSection(
  active: { statement: string; confidence: number; evidenceCount: number }[],
  former: { statement: string; peakConfidence: number; currentConfidence: number; demotedDate: string }[],
): string {
  const lines: string[] = [BEGIN_MARKER];

  if (active.length > 0) {
    lines.push('## Beliefs');
    lines.push('');
    for (const b of active) {
      lines.push(`- ${b.statement} (confidence: ${b.confidence.toFixed(2)}, evidence: ${b.evidenceCount})`);
    }
  }

  if (former.length > 0) {
    lines.push('');
    lines.push('## Former Beliefs');
    lines.push('');
    for (const b of former) {
      lines.push(`- [NO LONGER TRUE] ${b.statement} (was: ${b.peakConfidence.toFixed(2)}, now: ${b.currentConfidence.toFixed(2)}, demoted: ${b.demotedDate})`);
    }
  }

  lines.push('');
  lines.push(END_MARKER);
  return lines.join('\n');
}

export async function promoteBeliefs(db: Database): Promise<PromotionResult> {
  const now = Date.now();
  let totalPromoted = 0;
  let totalDemoted = 0;
  let totalRemoved = 0;

  // Get all distinct target paths that have beliefs worth considering
  const targetPaths = db.prepare(`
    SELECT DISTINCT
      CASE WHEN scope = 'global' THEN NULL ELSE project_path END AS target_path
    FROM beliefs
    WHERE status IN ('active', 'archived')
      AND (promoted_at IS NOT NULL
        OR (confidence_alpha / (confidence_alpha + confidence_beta) >= ?
            AND evidence_count >= ?))
      AND NOT (scope = 'project' AND project_path IS NULL)
  `).all(PROMOTE_CONFIDENCE, PROMOTE_MIN_EVIDENCE) as { target_path: string | null }[];

  // Also include paths where beliefs are currently promoted but may need demotion/removal
  const promotedPaths = db.prepare(`
    SELECT DISTINCT
      CASE WHEN scope = 'global' THEN NULL ELSE project_path END AS target_path
    FROM beliefs
    WHERE promoted_at IS NOT NULL
      AND NOT (scope = 'project' AND project_path IS NULL)
  `).all() as { target_path: string | null }[];

  // Merge target paths (dedup by value, treating null as a key)
  const pathSet = new Set<string | null>();
  for (const row of [...targetPaths, ...promotedPaths]) {
    pathSet.add(row.target_path);
  }

  for (const targetPath of pathSet) {
    // Verify project directory exists on disk (skip if not)
    if (targetPath !== null) {
      try {
        await fs.access(targetPath);
      } catch {
        continue; // project directory doesn't exist — skip
      }
    }

    // Fetch all relevant beliefs for this target
    const beliefs = db.prepare(`
      SELECT id, statement, confidence_alpha, confidence_beta, evidence_count,
             status, scope, project_path, promoted_at, demoted_at, peak_confidence
      FROM beliefs
      WHERE CASE WHEN ? IS NULL THEN scope = 'global' ELSE (scope = 'project' AND project_path = ?) END
        AND NOT (scope = 'project' AND project_path IS NULL)
        AND (promoted_at IS NOT NULL
          OR (status = 'active'
              AND confidence_alpha / (confidence_alpha + confidence_beta) >= ?
              AND evidence_count >= ?))
    `).all(targetPath, targetPath, PROMOTE_CONFIDENCE, PROMOTE_MIN_EVIDENCE) as BeliefRow[];

    const activeBeliefs: { id: string; statement: string; confidence: number; evidenceCount: number; score: number }[] = [];
    const formerBeliefs: { id: string; statement: string; peakConfidence: number; currentConfidence: number; demotedDate: string; demotedAt: number }[] = [];
    const toPromote: string[] = [];
    const toDemote: string[] = [];
    const toRemove: string[] = [];

    for (const belief of beliefs) {
      const conf = beliefConfidence(belief.confidence_alpha, belief.confidence_beta);
      const isActive = belief.status === 'active';
      const isPromoted = belief.promoted_at !== null;
      const isDemoted = belief.demoted_at !== null;

      if (isDemoted && isActive && conf >= PROMOTE_CONFIDENCE) {
        // Re-promotion: recovered confidence — move back to active
        activeBeliefs.push({
          id: belief.id,
          statement: belief.statement,
          confidence: conf,
          evidenceCount: belief.evidence_count,
          score: conf * Math.log(1 + belief.evidence_count),
        });
        // Clear demoted_at, ensure promoted_at is set
        if (!isPromoted) {
          toPromote.push(belief.id);
        }
        // Clear demoted_at via separate update below
        db.prepare(`UPDATE beliefs SET demoted_at = NULL WHERE id = ?`).run(belief.id);
        continue;
      }

      if (isPromoted && isDemoted) {
        // Currently in "Former Beliefs" section
        const demotedDaysAgo = (now - belief.demoted_at!) / (1000 * 60 * 60 * 24);

        if (conf < REMOVE_CONFIDENCE || demotedDaysAgo > DEMOTE_EXPIRY_DAYS || !isActive) {
          // Stage 2: Remove entirely
          toRemove.push(belief.id);
          totalRemoved++;
          console.error(`[belief-promoter] Removing belief "${belief.statement.slice(0, 60)}" (conf: ${conf.toFixed(2)}, demoted ${Math.round(demotedDaysAgo)}d ago)`);
          continue;
        }

        // Still in former section
        const peakConf = belief.peak_confidence ?? conf;
        const demotedDate = new Date(belief.demoted_at!).toISOString().split('T')[0];
        formerBeliefs.push({
          id: belief.id,
          statement: belief.statement,
          peakConfidence: peakConf,
          currentConfidence: conf,
          demotedDate,
          demotedAt: belief.demoted_at!,
        });
        continue;
      }

      if (isPromoted && !isDemoted) {
        // Currently in active section — check if it should be demoted
        if (conf < PROMOTE_CONFIDENCE || !isActive) {
          // Stage 1: Demote to former
          toDemote.push(belief.id);
          totalDemoted++;
          const peakConf = belief.peak_confidence ?? conf;
          const demotedDate = new Date(now).toISOString().split('T')[0];
          formerBeliefs.push({
            id: belief.id,
            statement: belief.statement,
            peakConfidence: peakConf,
            currentConfidence: conf,
            demotedDate,
            demotedAt: now,
          });
          continue;
        }

        // Still qualifies — keep in active
        activeBeliefs.push({
          id: belief.id,
          statement: belief.statement,
          confidence: conf,
          evidenceCount: belief.evidence_count,
          score: conf * Math.log(1 + belief.evidence_count),
        });
        continue;
      }

      // Not yet promoted — qualifies for promotion
      if (isActive && conf >= PROMOTE_CONFIDENCE && belief.evidence_count >= PROMOTE_MIN_EVIDENCE) {
        activeBeliefs.push({
          id: belief.id,
          statement: belief.statement,
          confidence: conf,
          evidenceCount: belief.evidence_count,
          score: conf * Math.log(1 + belief.evidence_count),
        });
        toPromote.push(belief.id);
      }
    }

    // Rank active beliefs and cap
    activeBeliefs.sort((a, b) => b.score - a.score);
    const cappedActive = activeBeliefs.slice(0, MAX_ACTIVE_BELIEFS);

    // Cap former beliefs (most recently demoted first)
    formerBeliefs.sort((a, b) => b.demotedAt - a.demotedAt);
    const cappedFormer = formerBeliefs.slice(0, MAX_FORMER_BELIEFS);

    // If nothing to write, skip file operations
    if (cappedActive.length === 0 && cappedFormer.length === 0 && toRemove.length === 0) {
      continue;
    }

    // Format the section
    const section = formatBeliefsSection(
      cappedActive.map(b => ({ statement: b.statement, confidence: b.confidence, evidenceCount: b.evidenceCount })),
      cappedFormer.map(b => ({ statement: b.statement, peakConfidence: b.peakConfidence, currentConfidence: b.currentConfidence, demotedDate: b.demotedDate })),
    );

    // Write to file
    const memoryPath = resolveMemoryPath(targetPath);
    const lockPath = memoryPath + '.lock';

    // Ensure directory exists BEFORE acquiring lock (lock creation needs the dir)
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });

    await withFileLock(lockPath, async () => {

      let existing = '';
      try {
        existing = await fs.readFile(memoryPath, 'utf-8');
      } catch {
        // File doesn't exist yet
      }

      const parsed = parseMarkerSection(existing);

      // If no active or former beliefs remain, and we had a section, remove it
      let newContent: string;
      if (cappedActive.length === 0 && cappedFormer.length === 0) {
        // Remove marker section entirely
        newContent = parsed.before + parsed.after;
      } else {
        // Place section at top (before + section + after, where before is empty for top placement)
        newContent = section + '\n' + parsed.before + parsed.after;
      }

      // Clean up any leading/trailing whitespace issues
      newContent = newContent.replace(/^\n+/, '');
      if (!newContent.endsWith('\n')) {
        newContent += '\n';
      }

      // Atomic write: tmp + rename
      const tmpPath = memoryPath + '.tmp.' + process.pid;
      await fs.writeFile(tmpPath, newContent, 'utf-8');
      await fs.rename(tmpPath, memoryPath);
    });

    // Update DB: set promoted_at for newly promoted
    if (toPromote.length > 0) {
      const stmt = db.prepare(`UPDATE beliefs SET promoted_at = ? WHERE id = ?`);
      for (const id of toPromote) {
        stmt.run(now, id);
      }
      totalPromoted += toPromote.length;
    }

    // Update DB: set demoted_at for newly demoted
    if (toDemote.length > 0) {
      const stmt = db.prepare(`UPDATE beliefs SET demoted_at = ? WHERE id = ?`);
      for (const id of toDemote) {
        stmt.run(now, id);
      }
    }

    // Update DB: clear promoted_at and demoted_at for removed
    if (toRemove.length > 0) {
      const stmt = db.prepare(`UPDATE beliefs SET promoted_at = NULL, demoted_at = NULL WHERE id = ?`);
      for (const id of toRemove) {
        stmt.run(id);
      }
    }
  }

  return { promoted: totalPromoted, demoted: totalDemoted, removed: totalRemoved };
}
