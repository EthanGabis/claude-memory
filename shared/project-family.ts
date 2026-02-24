import type { Database } from 'bun:sqlite';

// Singleton family cache: full_path → family names (self + all descendants)
let familyCache: Map<string, string[]> | null = null;
// Reverse lookup: project name → full_path (first match wins)
let nameToPath: Map<string, string> | null = null;
// Singleton family cache: full_path → family full_paths (self + all descendants)
let pathFamilyCache: Map<string, string[]> | null = null;

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
  if (!familyCache || !nameToPath || !pathFamilyCache) {
    const result = buildFamilyCache(db);
    familyCache = result.byPath;
    nameToPath = result.nameToPath;
    pathFamilyCache = result.pathFamily;
  }
  // Resolve name → full_path, then look up family
  const fullPath = nameToPath.get(projectName);
  if (!fullPath) return [projectName]; // Unknown project — return self only
  return familyCache.get(fullPath) ?? [projectName];
}

/**
 * Get the full family of project full_paths for a given project.
 * Returns [projectFullPath, ...all descendant full_paths].
 * Returns [] if the project is unknown.
 * Uses a lazy-built in-memory cache invalidated by invalidateFamilyCache().
 */
export function getProjectFamilyPaths(db: Database, projectName: string): string[] {
  if (!familyCache || !nameToPath || !pathFamilyCache) {
    const result = buildFamilyCache(db);
    familyCache = result.byPath;
    nameToPath = result.nameToPath;
    pathFamilyCache = result.pathFamily;
  }
  const fullPath = nameToPath.get(projectName);
  if (!fullPath) return [];
  return pathFamilyCache.get(fullPath) ?? [];
}

/**
 * Invalidate the family cache. Call after any project upsert that changes
 * parent_project relationships.
 */
export function invalidateFamilyCache(): void {
  familyCache = null;
  nameToPath = null;
  pathFamilyCache = null;
}

/**
 * Generate a SQL IN clause placeholder string for an array of values.
 * e.g. sqlInPlaceholders(['a', 'b', 'c']) → '?, ?, ?'
 */
export function sqlInPlaceholders(values: string[]): string {
  return values.map(() => '?').join(', ');
}

/**
 * O(N²) in-memory parent detection. Sorts all projects by path length DESC
 * and finds the immediate parent (deepest ancestor) for each project.
 * Returns a Map<full_path, parent_full_path | null>.
 */
export function detectParentsInMemory(projects: { full_path: string }[]): Map<string, string | null> {
  // Sort by path length DESC (deepest first)
  const sorted = [...projects].sort((a, b) => b.full_path.length - a.full_path.length);
  const result = new Map<string, string | null>();

  for (const project of projects) {
    let parent: string | null = null;
    for (const candidate of sorted) {
      if (candidate.full_path === project.full_path) continue;
      if (project.full_path.startsWith(candidate.full_path + '/')) {
        parent = candidate.full_path;
        break; // First match is deepest ancestor = immediate parent
      }
    }
    result.set(project.full_path, parent);
  }
  return result;
}

/**
 * Generate an efficient SQL filter for a family of project names/paths.
 * For small families (<=100), uses IN (...placeholders...).
 * For large families, uses a temp table to avoid SQLite variable limits.
 */
export function sqlFamilyFilter(
  db: Database,
  family: string[],
  column: string,
): { clause: string; params: string[]; cleanup?: () => void } {
  if (family.length <= 100) {
    return {
      clause: `${column} IN (${sqlInPlaceholders(family)})`,
      params: family,
    };
  }
  // Use temp table for large families
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _family_filter (val TEXT PRIMARY KEY)');
  db.exec('DELETE FROM _family_filter');
  const insert = db.prepare('INSERT OR IGNORE INTO _family_filter (val) VALUES (?)');
  for (const v of family) insert.run(v);
  return {
    clause: `${column} IN (SELECT val FROM _family_filter)`,
    params: [],
    cleanup: () => db.exec('DELETE FROM _family_filter'),
  };
}

/**
 * Build the family cache from the projects table.
 * Creates an adjacency list keyed by full_path, then BFS from each project
 * to compute the transitive closure of descendants.
 */
function buildFamilyCache(db: Database): {
  byPath: Map<string, string[]>;
  nameToPath: Map<string, string>;
  pathFamily: Map<string, string[]>;
} {
  const projects = db.prepare(
    `SELECT name, full_path, parent_project FROM projects ORDER BY full_path`
  ).all() as { name: string; full_path: string; parent_project: string | null }[];

  // Build adjacency: parent_full_path → [child_full_path, ...]
  const childrenOf = new Map<string, string[]>();
  const pathToName = new Map<string, string>();
  const nameToPathMap = new Map<string, string>();

  for (const p of projects) {
    pathToName.set(p.full_path, p.name);
    // First name wins — deterministic because projects are ORDER BY full_path
    if (!nameToPathMap.has(p.name)) {
      nameToPathMap.set(p.name, p.full_path);
    }
    if (p.parent_project) {
      const existing = childrenOf.get(p.parent_project) ?? [];
      existing.push(p.full_path); // Store full_path, not name
      childrenOf.set(p.parent_project, existing);
    }
  }

  // For each project, BFS to compute all descendant names (with cycle guard)
  const byPath = new Map<string, string[]>();
  for (const p of projects) {
    const family = [p.name];
    const queue = [p.full_path];
    const visited = new Set<string>([p.full_path]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const childPaths = childrenOf.get(current) ?? [];
      for (const childPath of childPaths) {
        if (visited.has(childPath)) continue;
        visited.add(childPath);
        const childName = pathToName.get(childPath);
        if (childName) {
          family.push(childName);
          queue.push(childPath);
        }
      }
    }
    byPath.set(p.full_path, family);
  }

  // For each project, BFS to compute all descendant full_paths (with cycle guard)
  const pathFamily = new Map<string, string[]>();
  for (const p of projects) {
    const familyPaths = [p.full_path];
    const queue = [p.full_path];
    const visited = new Set<string>([p.full_path]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const childPaths = childrenOf.get(current) ?? [];
      for (const childPath of childPaths) {
        if (!visited.has(childPath)) {
          visited.add(childPath);
          familyPaths.push(childPath);
          queue.push(childPath);
        }
      }
    }
    pathFamily.set(p.full_path, familyPaths);
  }

  return { byPath, nameToPath: nameToPathMap, pathFamily };
}
