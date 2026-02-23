/**
 * migrate/extract.ts
 *
 * Step 1 of the claude-mem → claude-memory migration pipeline.
 * Reads ~/.claude-mem/claude-mem.db (read-only), joins sessions with
 * summaries and observations, groups by project + date, and writes
 * per-project JSON files to /tmp/claude-memory-migration/.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
// ---------------------------------------------------------------------------
// Path resolution: map short project names → filesystem paths
// ---------------------------------------------------------------------------
const HOME = homedir();
const PROJECTS_ROOT = join(HOME, "Desktop", "Projects");
/**
 * Known mappings from claude-mem project slugs to absolute paths.
 * We try several heuristics:
 *   1. Direct child of ~/Desktop/Projects/<slug>
 *   2. Nested child ~/Desktop/Projects/**\/<slug> (one level deep)
 *   3. Home directory itself (for "ethangabis" slug → global)
 * Returns null if no valid path is found (→ orphan).
 */
function resolveProjectPath(slug) {
    // Special case: user home directory slug → global layer
    if (slug === basename(HOME)) {
        return HOME;
    }
    // Direct child: ~/Desktop/Projects/<slug>
    const direct = join(PROJECTS_ROOT, slug);
    if (existsSync(direct))
        return direct;
    // One-level nested: ~/Desktop/Projects/*/<slug>
    // Check common parent dirs (TTS/TrueTTS pattern)
    try {
        const parents = readdirSync(PROJECTS_ROOT);
        for (const parent of parents) {
            const parentPath = join(PROJECTS_ROOT, parent);
            try {
                if (statSync(parentPath).isDirectory()) {
                    const nested = join(parentPath, slug);
                    if (existsSync(nested))
                        return nested;
                }
            }
            catch {
                // skip unreadable entries
            }
        }
    }
    catch {
        // PROJECTS_ROOT doesn't exist or not readable
    }
    return null;
}
// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------
function tableExists(db, tableName) {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName);
    return row !== undefined;
}
function columnExists(db, tableName, columnName) {
    const columns = db.query(`PRAGMA table_info(${tableName})`).all();
    return columns.some((c) => c.name === columnName);
}
// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------
function main() {
    const dbPath = join(HOME, ".claude-mem", "claude-mem.db");
    if (!existsSync(dbPath)) {
        console.error(`ERROR: claude-mem.db not found at ${dbPath}`);
        console.error("Make sure claude-mem is installed and has been run at least once.");
        process.exit(1);
    }
    const db = new Database(dbPath, { readonly: true });
    // --- Check required tables ---
    const requiredTables = ["sdk_sessions", "session_summaries", "observations"];
    const availableTables = {};
    for (const t of requiredTables) {
        availableTables[t] = tableExists(db, t);
        if (!availableTables[t]) {
            console.warn(`WARNING: Table '${t}' not found in database — skipping.`);
        }
    }
    if (!availableTables.sdk_sessions) {
        console.error("ERROR: sdk_sessions table is required but missing. Cannot proceed.");
        db.close();
        process.exit(1);
    }
    // --- Query sessions ---
    const sessions = db
        .prepare(`SELECT
        memory_session_id,
        project,
        started_at,
        started_at_epoch
      FROM sdk_sessions
      ORDER BY started_at_epoch ASC`)
        .all();
    console.log(`Found ${sessions.length} sessions in sdk_sessions.`);
    const summariesMap = new Map();
    if (availableTables.session_summaries) {
        const hasCols = {
            request: columnExists(db, "session_summaries", "request"),
            investigated: columnExists(db, "session_summaries", "investigated"),
            learned: columnExists(db, "session_summaries", "learned"),
            completed: columnExists(db, "session_summaries", "completed"),
        };
        const summarySelect = [
            "memory_session_id",
            hasCols.request ? "request" : "NULL AS request",
            hasCols.investigated ? "investigated" : "NULL AS investigated",
            hasCols.learned ? "learned" : "NULL AS learned",
            hasCols.completed ? "completed" : "NULL AS completed",
        ].join(", ");
        const summaryOrderBy = columnExists(db, "session_summaries", "created_at_epoch")
            ? "ORDER BY created_at_epoch ASC"
            : "ORDER BY rowid ASC";
        const rows = db
            .prepare(`SELECT ${summarySelect}
        FROM session_summaries
        ${summaryOrderBy}`)
            .all();
        for (const row of rows) {
            const key = row.memory_session_id;
            if (!summariesMap.has(key))
                summariesMap.set(key, []);
            summariesMap.get(key).push(row);
        }
        console.log(`Found ${rows.length} summary rows across ${summariesMap.size} sessions.`);
    }
    const observationsMap = new Map();
    if (availableTables.observations) {
        const hasCols = {
            title: columnExists(db, "observations", "title"),
            narrative: columnExists(db, "observations", "narrative"),
            files_modified: columnExists(db, "observations", "files_modified"),
            type: columnExists(db, "observations", "type"),
        };
        const obsSelect = [
            "memory_session_id",
            hasCols.title ? "title" : "NULL AS title",
            hasCols.narrative ? "narrative" : "NULL AS narrative",
            hasCols.files_modified ? "files_modified" : "NULL AS files_modified",
            hasCols.type ? "type" : "NULL AS type",
        ].join(", ");
        const obsOrderBy = columnExists(db, "observations", "created_at_epoch")
            ? "ORDER BY created_at_epoch ASC"
            : "ORDER BY rowid ASC";
        const rows = db
            .prepare(`SELECT ${obsSelect}
        FROM observations
        ${obsOrderBy}`)
            .all();
        for (const row of rows) {
            const key = row.memory_session_id;
            if (!observationsMap.has(key))
                observationsMap.set(key, []);
            observationsMap.get(key).push(row);
        }
        console.log(`Found ${rows.length} observation rows across ${observationsMap.size} sessions.`);
    }
    db.close();
    // --- Group by project slug → date → sessions ---
    // Key: project slug, Value: ProjectFile being built
    const projectFiles = new Map();
    const orphanSessions = [];
    for (const session of sessions) {
        const slug = session.project;
        // Parse date/time from ISO started_at
        const startDate = new Date(session.started_at);
        const date = startDate.toISOString().slice(0, 10); // YYYY-MM-DD
        const time = startDate.toISOString().slice(11, 16); // HH:MM
        // Merge all summaries for this session into one combined entry
        const sessionSummaries = (session.memory_session_id
            ? summariesMap.get(session.memory_session_id)
            : undefined) ?? [];
        // Merge all observations for this session
        const sessionObservations = (session.memory_session_id
            ? observationsMap.get(session.memory_session_id)
            : undefined) ?? [];
        // If multiple summaries exist for one session, concatenate their fields
        const mergedSummary = {
            request: sessionSummaries
                .map((s) => s.request)
                .filter(Boolean)
                .join("\n\n") || null,
            investigated: sessionSummaries
                .map((s) => s.investigated)
                .filter(Boolean)
                .join("\n\n") || null,
            learned: sessionSummaries
                .map((s) => s.learned)
                .filter(Boolean)
                .join("\n\n") || null,
            completed: sessionSummaries
                .map((s) => s.completed)
                .filter(Boolean)
                .join("\n\n") || null,
        };
        const entry = {
            date,
            time,
            request: mergedSummary.request,
            investigated: mergedSummary.investigated,
            learned: mergedSummary.learned,
            completed: mergedSummary.completed,
            observations: sessionObservations.map((o) => ({
                title: o.title,
                narrative: o.narrative,
                filesModified: o.files_modified,
                type: o.type,
            })),
        };
        // Fix 1: Guard against null/empty/undefined project slugs → orphan
        if (!slug) {
            orphanSessions.push(entry);
            continue;
        }
        // Fix 3: Sanitize slug to prevent path traversal in output filenames
        const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "_");
        const resolvedPath = resolveProjectPath(slug);
        if (resolvedPath === null) {
            // Orphan: project path not resolvable
            orphanSessions.push(entry);
        }
        else {
            if (!projectFiles.has(safeSlug)) {
                projectFiles.set(safeSlug, {
                    projectPath: resolvedPath,
                    projectSlug: safeSlug,
                    sessions: [],
                });
            }
            projectFiles.get(safeSlug).sessions.push(entry);
        }
    }
    // --- Write output ---
    const outputDir = "/tmp/claude-memory-migration";
    mkdirSync(outputDir, { recursive: true });
    // Per-project JSON files
    const manifestProjects = [];
    for (const [slug, projectFile] of projectFiles) {
        const outPath = join(outputDir, `${slug}.json`);
        writeFileSync(outPath, JSON.stringify(projectFile, null, 2));
        console.log(`Wrote ${projectFile.sessions.length} sessions → ${outPath}`);
        manifestProjects.push({
            slug,
            path: projectFile.projectPath,
            sessionCount: projectFile.sessions.length,
        });
    }
    // Orphans file
    const orphansPath = join(outputDir, "orphans.json");
    if (orphanSessions.length > 0) {
        writeFileSync(orphansPath, JSON.stringify({
            projectPath: null,
            projectSlug: "orphans",
            sessions: orphanSessions,
        }, null, 2));
        console.log(`Wrote ${orphanSessions.length} orphan sessions → ${orphansPath}`);
    }
    // Manifest
    const manifest = {
        projects: manifestProjects.sort((a, b) => b.sessionCount - a.sessionCount),
        orphanCount: orphanSessions.length,
        orphansFile: orphanSessions.length > 0 ? orphansPath : null,
        extractedAt: new Date().toISOString(),
    };
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Wrote manifest → ${manifestPath}`);
    // --- Summary ---
    console.log("\n--- Extraction Summary ---");
    console.log(`Total sessions: ${sessions.length}`);
    console.log(`Projects found: ${projectFiles.size}`);
    for (const [slug, pf] of projectFiles) {
        console.log(`  ${slug}: ${pf.sessions.length} sessions → ${pf.projectPath}`);
    }
    console.log(`Orphan sessions: ${orphanSessions.length}`);
    console.log(`Output directory: ${outputDir}`);
}
main();
