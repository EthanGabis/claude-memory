import type { Database } from 'bun:sqlite';

// Singleton family cache: full_path → family names (self + all descendants)
let familyCache: Map<string, string[]> | null = null;
// Reverse lookup: project name → full_path (first match wins)
let nameToPath: Map<string, string> | null = null;

/**
 * Detect the immediate parent project by path-prefix matching.
 * Iterates longest paths first so we find the closest ancestor, not the root.
 * Returns the parent's full_path, or null if this is a top-level project.
 */
export function detectParentProject(db: Database, fullPath: string): string | null {
  const projects = db.prepare(
    `SELECT full_path FROM projects ORDER BY LENGTH(full_path) DESC`
  ).all() as { full_path: string }[];

  for (const row of projects) {
    if (row.full_path === fullPath) continue;
    if (fullPath.startsWith(row.full_path + '/')) {
      return row.full_path; // Immediate parent (deepest ancestor)
    }
  }
  return null;
}

/**
 * Get the full family of project names for a given project.
 * Returns [projectName, ...all descendant names].
 * Falls back to [projectName] if the project is unknown.
 * Uses a lazy-built in-memory cache invalidated by invalidateFamilyCache().
 */
export function getProjectFamily(db: Database, projectName: string): string[] {
  if (!familyCache || !nameToPath) {
    const result = buildFamilyCache(db);
    familyCache = result.byPath;
    nameToPath = result.nameToPath;
  }
  // Resolve name → full_path, then look up family
  const fullPath = nameToPath.get(projectName);
  if (!fullPath) return [projectName]; // Unknown project — return self only
  return familyCache.get(fullPath) ?? [projectName];
}

/**
 * Invalidate the family cache. Call after any project upsert that changes
 * parent_project relationships.
 */
export function invalidateFamilyCache(): void {
  familyCache = null;
  nameToPath = null;
}

/**
 * Generate a SQL IN clause placeholder string for an array of values.
 * e.g. sqlInPlaceholders(['a', 'b', 'c']) → '?, ?, ?'
 */
export function sqlInPlaceholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}

/**
 * Build the family cache from the projects table.
 * Creates an adjacency list keyed by full_path, then BFS from each project
 * to compute the transitive closure of descendants.
 */
function buildFamilyCache(db: Database): {
  byPath: Map<string, string[]>;
  nameToPath: Map<string, string>;
} {
  const projects = db.prepare(
    `SELECT name, full_path, parent_project FROM projects`
  ).all() as { name: string; full_path: string; parent_project: string | null }[];

  // Build adjacency: parent_full_path → [child_full_path, ...]
  const childrenOf = new Map<string, string[]>();
  const pathToName = new Map<string, string>();
  const nameToPathMap = new Map<string, string>();

  for (const p of projects) {
    pathToName.set(p.full_path, p.name);
    // First name wins (name collisions: keep the first-seen full_path)
    if (!nameToPathMap.has(p.name)) {
      nameToPathMap.set(p.name, p.full_path);
    }
    if (p.parent_project) {
      const existing = childrenOf.get(p.parent_project) ?? [];
      existing.push(p.full_path); // Store full_path, not name
      childrenOf.set(p.parent_project, existing);
    }
  }

  // For each project, BFS to compute all descendants
  const byPath = new Map<string, string[]>();
  for (const p of projects) {
    const family = [p.name];
    const queue = [p.full_path];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const childPaths = childrenOf.get(current) ?? [];
      for (const childPath of childPaths) {
        const childName = pathToName.get(childPath);
        if (childName) {
          family.push(childName);
          queue.push(childPath); // Continue BFS — no ambiguity
        }
      }
    }
    byPath.set(p.full_path, family);
  }

  return { byPath, nameToPath: nameToPathMap };
}
