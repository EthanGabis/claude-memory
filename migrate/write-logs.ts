/**
 * migrate/write-logs.ts
 *
 * Step 2 of the claude-mem → claude-memory migration pipeline.
 * Reads the JSON files produced by extract.ts from /tmp/claude-memory-migration/,
 * groups sessions by date, and writes daily Markdown log files per project.
 *
 * Output paths:
 *   - Project exists on disk: <projectPath>/.claude/memory/YYYY-MM-DD.md
 *   - Project missing from disk: ~/.claude-memory/memory/archive/YYYY-MM-DD-<slug>.md
 *   - Orphan sessions: ~/.claude-memory/memory/YYYY-MM-DD.md
 *
 * Safety:
 *   - Never overwrites existing files — appends under <!-- migrated --> separator
 *   - Skips if <!-- migrated --> marker already present (no double-migration)
 *   - Creates parent directories as needed
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types (mirrors extract.ts output)
// ---------------------------------------------------------------------------

interface Observation {
  title: string | null;
  narrative: string | null;
  filesModified: string | null;
  type: string | null;
}

interface SessionEntry {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  observations: Observation[];
}

interface ProjectFile {
  projectPath: string | null;
  projectSlug: string;
  sessions: SessionEntry[];
}

interface ManifestEntry {
  slug: string;
  path: string;
  sessionCount: number;
}

interface Manifest {
  projects: ManifestEntry[];
  orphanCount: number;
  orphansFile: string | null;
  extractedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const MIGRATION_DIR = "/tmp/claude-memory-migration";
const GLOBAL_MEMORY_DIR = join(HOME, ".claude-memory", "memory");
const ARCHIVE_DIR = join(GLOBAL_MEMORY_DIR, "archive");
const MIGRATED_MARKER = '<!-- claude-mem-migrated -->';

// ---------------------------------------------------------------------------
// Emoji mapping for observation types
// ---------------------------------------------------------------------------

function observationEmoji(type: string | null): string {
  if (!type) return "⚪";
  const t = type.toLowerCase();
  if (t === "bugfix" || t === "bug") return "🔴";
  if (t === "feature") return "🟣";
  if (t === "refactor") return "🔄";
  if (t === "change" || t === "decision") return "✅";
  if (t === "discovery") return "🔵";
  return "⚪";
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderSession(session: SessionEntry): string {
  const lines: string[] = [];

  lines.push(`## ${session.time} Session`);
  lines.push("");

  lines.push(`**Request:** ${session.request ?? '—'}`);
  lines.push(`**Investigated:** ${session.investigated ?? '—'}`);
  lines.push(`**Learned:** ${session.learned ?? '—'}`);
  lines.push(`**Completed:** ${session.completed ?? '—'}`);

  if (session.observations.length > 0) {
    lines.push("");
    lines.push("### Observations");
    for (const obs of session.observations) {
      const emoji = observationEmoji(obs.type);
      const title = obs.title || "Untitled";
      lines.push(`#### ${emoji} ${title}`);
      if (obs.narrative) lines.push(obs.narrative);
      if (obs.filesModified) lines.push(`Files: ${obs.filesModified}`);
    }
  }

  return lines.join("\n");
}

function renderDayFile(date: string, sessions: SessionEntry[]): string {
  // Sort sessions by time ascending within each day
  const sorted = [...sessions].sort((a, b) => a.time.localeCompare(b.time));

  const lines: string[] = [];
  lines.push(`# ${date}`);
  lines.push("");

  for (const session of sorted) {
    lines.push(renderSession(session));
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// File writing with safety checks
// ---------------------------------------------------------------------------

function safeWriteLogFile(filePath: string, content: string): void {
  // Create parent directories
  const parentDir = path.dirname(filePath);
  mkdirSync(parentDir, { recursive: true });

  if (existsSync(filePath)) {
    // Check if already migrated
    const existing = readFileSync(filePath, "utf-8");
    if (existing.includes(MIGRATED_MARKER)) {
      console.log(`  SKIP (already migrated): ${filePath}`);
      return;
    }

    // Append under migrated separator
    const appendContent = `\n\n${MIGRATED_MARKER}\n\n${content}`;
    appendFileSync(filePath, appendContent);
    console.log(`  APPEND: ${filePath}`);
  } else {
    writeFileSync(filePath, content);
    console.log(`  WRITE: ${filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Group sessions by date
// ---------------------------------------------------------------------------

function groupByDate(sessions: SessionEntry[]): Map<string, SessionEntry[]> {
  const groups = new Map<string, SessionEntry[]>();
  for (const session of sessions) {
    if (!groups.has(session.date)) groups.set(session.date, []);
    groups.get(session.date)!.push(session);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Process a single project
// ---------------------------------------------------------------------------

function processProject(projectFile: ProjectFile): number {
  const { projectPath, projectSlug, sessions } = projectFile;

  // Determine if project path exists on disk
  const pathExists = projectPath !== null && existsSync(projectPath);

  const dateGroups = groupByDate(sessions);
  let filesWritten = 0;

  for (const [date, daySessions] of dateGroups) {
    const content = renderDayFile(date, daySessions);

    let filePath: string;
    if (pathExists) {
      // Write to <projectPath>/.claude/memory/YYYY-MM-DD.md
      filePath = join(projectPath!, ".claude", "memory", `${date}.md`);
    } else {
      // Archive: project path missing from filesystem
      filePath = join(ARCHIVE_DIR, `${date}-${projectSlug}.md`);
    }

    safeWriteLogFile(filePath, content);
    filesWritten++;
  }

  return filesWritten;
}

// ---------------------------------------------------------------------------
// Process orphan sessions
// ---------------------------------------------------------------------------

function processOrphans(sessions: SessionEntry[]): number {
  const dateGroups = groupByDate(sessions);
  let filesWritten = 0;

  for (const [date, daySessions] of dateGroups) {
    const content = renderDayFile(date, daySessions);
    const filePath = join(GLOBAL_MEMORY_DIR, `${date}.md`);

    safeWriteLogFile(filePath, content);
    filesWritten++;
  }

  return filesWritten;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const manifestPath = join(MIGRATION_DIR, "manifest.json");

  if (!existsSync(manifestPath)) {
    console.error(`ERROR: manifest.json not found at ${manifestPath}`);
    console.error("Run extract.ts first: bun run migrate/extract.ts");
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  console.log(`Reading manifest: ${manifest.projects.length} projects, ${manifest.orphanCount} orphans`);
  console.log(`Extracted at: ${manifest.extractedAt}`);
  console.log("");

  let totalFiles = 0;

  // Process each project
  for (const entry of manifest.projects) {
    const projectJsonPath = join(MIGRATION_DIR, `${entry.slug}.json`);

    if (!existsSync(projectJsonPath)) {
      console.warn(`WARNING: ${projectJsonPath} not found — skipping project '${entry.slug}'`);
      continue;
    }

    let projectFile: ProjectFile;
    try {
      projectFile = JSON.parse(readFileSync(projectJsonPath, "utf-8"));
    } catch (err) {
      console.warn(`[write-logs] Skipping corrupt/unreadable project file: ${projectJsonPath}`, (err as Error).message);
      continue;
    }
    console.log(`Project: ${entry.slug} (${projectFile.sessions.length} sessions → ${entry.path})`);

    const count = processProject(projectFile);
    totalFiles += count;
    console.log("");
  }

  // Process orphans
  if (manifest.orphanCount > 0 && manifest.orphansFile) {
    const orphansPath = manifest.orphansFile;

    if (!existsSync(orphansPath)) {
      console.warn(`WARNING: orphans.json not found at ${orphansPath} — skipping orphans`);
    } else {
      let orphanFile: ProjectFile | null = null;
      try {
        orphanFile = JSON.parse(readFileSync(orphansPath, "utf-8"));
      } catch (err) {
        console.warn(`[write-logs] Skipping corrupt/unreadable orphans file: ${orphansPath}`, (err as Error).message);
      }

      if (orphanFile) {
        console.log(`Orphans: ${orphanFile.sessions.length} sessions → ${GLOBAL_MEMORY_DIR}/`);

        const count = processOrphans(orphanFile.sessions);
        totalFiles += count;
        console.log("");
      }
    }
  }

  // Summary
  console.log("--- Write Summary ---");
  console.log(`Total daily log files written/appended: ${totalFiles}`);
  console.log(`Projects processed: ${manifest.projects.length}`);
  if (manifest.orphanCount > 0) {
    console.log(`Orphan sessions processed: ${manifest.orphanCount}`);
  }
}

main();
