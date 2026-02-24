import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import { getProjectFamilyPaths, sqlInPlaceholders } from './project-family.js';

interface ProjectRow {
  name: string;
  full_path: string | null;
  description: string | null;
  source: string;
}

/**
 * Upsert a project into the projects table.
 * If the project already exists, updates full_path, parent_project, and updated_at (but not description/source).
 */
export function upsertProject(
  db: Database,
  name: string,
  fullPath: string,
  parentProject: string | null = null,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO projects (full_path, name, description, source, parent_project, created_at, updated_at)
    VALUES (?, ?, NULL, 'auto', ?, ?, ?)
    ON CONFLICT(full_path) DO UPDATE SET
      name = excluded.name,
      parent_project = excluded.parent_project,
      updated_at = excluded.updated_at
  `).run(fullPath, name, parentProject, now, now);
}

/**
 * Generate and store a project description.
 * Priority: 1) CLAUDE.md content, 2) LLM summary from episodes, 3) null
 */
export async function generateProjectDescription(
  projectPath: string,
  projectName: string,
  db: Database,
  openaiClient: any,
): Promise<string | null> {
  // Check if already described (query by full_path, which is the PRIMARY KEY)
  const existing = db.prepare(
    `SELECT description, source FROM projects WHERE full_path = ?`
  ).get(projectPath) as ProjectRow | null;

  if (existing?.description && existing.source !== 'auto') {
    return existing.description; // Manual or CLAUDE.md description -- don't overwrite
  }

  // Strategy 1: Read CLAUDE.md
  const claudeMdPaths = [
    path.join(projectPath, 'CLAUDE.md'),
    path.join(projectPath, '.claude', 'CLAUDE.md'),
  ];

  for (const mdPath of claudeMdPaths) {
    try {
      const content = fs.readFileSync(mdPath, 'utf-8');
      if (content.trim().length > 20) {
        const description = await summarizeWithLlm(
          `Summarize this project in 1-2 sentences based on this CLAUDE.md:\n\n${content.slice(0, 3000)}`,
          openaiClient,
        );
        if (description) {
          const now = Date.now();
          db.prepare(
            `UPDATE projects SET description = ?, source = 'claude_md', updated_at = ? WHERE full_path = ?`
          ).run(description, now, projectPath);
          return description;
        }
      }
    } catch {
      // File not found -- try next
    }
  }

  // Strategy 2: Summarize from recent episodes (family-aware: includes child projects)
  const familyPaths = getProjectFamilyPaths(db, projectName);
  let episodes: { summary: string }[];
  if (familyPaths.length === 0) {
    // Fallback: unknown project — filter by project name for backward compat
    episodes = db.prepare(`
      SELECT summary FROM episodes
      WHERE project = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(projectName) as { summary: string }[];
  } else {
    const placeholders = sqlInPlaceholders(familyPaths);
    episodes = db.prepare(`
      SELECT summary FROM episodes
      WHERE project_path IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT 10
    `).all(...familyPaths) as { summary: string }[];
  }

  if (episodes.length >= 3) {
    const episodeSummaries = episodes.map(e => `- ${e.summary}`).join('\n');
    const description = await summarizeWithLlm(
      `Based on these memory episodes, describe this project in 1-2 sentences:\n\n${episodeSummaries}`,
      openaiClient,
    );
    if (description) {
      const now = Date.now();
      db.prepare(
        `UPDATE projects SET description = ?, source = 'auto', updated_at = ? WHERE full_path = ?`
      ).run(description, now, projectPath);
      return description;
    }
  }

  return null;
}

/**
 * Call LLM to generate a short summary.
 * Accepts an existing OpenAI client instance (reuse from extractor singleton).
 */
async function summarizeWithLlm(prompt: string, client: any): Promise<string | null> {
  if (!client) return null;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: 'You are a concise technical writer. Respond with 1-2 sentences only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });
    const text = response.choices[0]?.message?.content?.trim();
    return text && text.length > 10 ? text : null;
  } catch {
    return null;
  }
}
