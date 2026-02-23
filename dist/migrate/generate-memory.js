#!/usr/bin/env bun
/**
 * migrate/generate-memory.ts
 *
 * Step 3 of the claude-mem → claude-memory migration pipeline.
 * Reads per-project JSON files produced by extract.ts from
 * /tmp/claude-memory-migration/, and writes a MEMORY.md summary
 * for each project that has more than 2 sessions.
 *
 * No external AI API is called — summaries are built directly from
 * the structured session data.
 *
 * Output paths:
 *   - Project exists on disk: <projectPath>/.claude/memory/MEMORY.md
 *   - Project missing from disk: ~/.claude-memory/memory/archive/<slug>-MEMORY.md
 *
 * Safety:
 *   - Skips projects whose MEMORY.md already exists (idempotent)
 *   - Skips orphan projects (no meaningful project to attribute to)
 *   - Wraps file reads in try/catch with continue on failure
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HOME = os.homedir();
const MIGRATION_DIR = "/tmp/claude-memory-migration";
const ARCHIVE_DIR = path.join(HOME, ".claude-memory", "memory", "archive");
// ---------------------------------------------------------------------------
// Emoji mapping for observation types (matches write-logs.ts)
// ---------------------------------------------------------------------------
function observationEmoji(type) {
    if (!type)
        return "⚪";
    const t = type.toLowerCase();
    if (t === "bugfix" || t === "bug")
        return "🔴";
    if (t === "feature")
        return "🟣";
    if (t === "refactor")
        return "🔄";
    if (t === "change" || t === "decision")
        return "✅";
    if (t === "discovery")
        return "🔵";
    return "⚪";
}
// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function truncate(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen - 1) + "…";
}
// ---------------------------------------------------------------------------
// Normalise either JSON shape into a consistent NormalisedProject
// ---------------------------------------------------------------------------
function normaliseProject(raw, slug) {
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    // --- Day-grouped format (plan spec) ---
    if (Array.isArray(r.days)) {
        const dayFormat = raw;
        const sessions = [];
        for (const day of dayFormat.days) {
            for (const s of day.sessions) {
                sessions.push({
                    date: day.date,
                    time: s.time,
                    request: s.request,
                    investigated: s.investigated,
                    learned: s.learned,
                    completed: s.completed,
                    observations: s.observations.map((o) => ({
                        title: o.title,
                        narrative: o.narrative,
                        filesModified: o.filesModified,
                        type: o.type,
                    })),
                });
            }
        }
        return {
            projectPath: dayFormat.projectPath ?? null,
            projectName: dayFormat.projectName ?? slug,
            projectSlug: slug,
            sessions,
        };
    }
    // --- Flat format (extract.ts actual output) ---
    if (Array.isArray(r.sessions)) {
        const flatFormat = raw;
        const projectName = typeof r.projectName === "string"
            ? r.projectName
            : deriveNameFromPath(flatFormat.projectPath, slug);
        return {
            projectPath: flatFormat.projectPath ?? null,
            projectName,
            projectSlug: flatFormat.projectSlug ?? slug,
            sessions: flatFormat.sessions,
        };
    }
    return null;
}
function deriveNameFromPath(projectPath, fallback) {
    if (!projectPath)
        return fallback;
    return path.basename(projectPath) || fallback;
}
// ---------------------------------------------------------------------------
// Group sessions by date (sorted)
// ---------------------------------------------------------------------------
function groupByDate(sessions) {
    const groups = new Map();
    for (const s of sessions) {
        if (!groups.has(s.date))
            groups.set(s.date, []);
        groups.get(s.date).push(s);
    }
    // Return sorted by date ascending
    return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
// ---------------------------------------------------------------------------
// Build MEMORY.md content
// ---------------------------------------------------------------------------
function buildMemoryMd(project) {
    const { projectName, sessions } = project;
    const dateGroups = groupByDate(sessions);
    const validDates = [...dateGroups.keys()].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const earliestDate = validDates[0] ?? "unknown";
    const latestDate = validDates[validDates.length - 1] ?? "unknown";
    const nSessions = sessions.length;
    const lines = [];
    // --- Title ---
    lines.push(`# Project Memory: ${projectName}`);
    lines.push("");
    // --- Overview ---
    lines.push("## Overview");
    lines.push(`This project was worked on across ${nSessions} session${nSessions === 1 ? "" : "s"} from ${earliestDate} to ${latestDate}.`);
    lines.push("");
    // --- Sessions Summary ---
    lines.push("## Sessions Summary");
    lines.push("");
    for (const [date, daySessions] of dateGroups) {
        const count = daySessions.length;
        const requests = daySessions
            .map((s) => s.request)
            .filter((r) => typeof r === "string" && r.trim().length > 0)
            .map((r) => truncate(r.replace(/\n/g, " "), 60));
        const requestPart = requests.length > 0 ? ` — ${requests.join(", ")}` : "";
        lines.push(`- **${date}**: ${count} session${count === 1 ? "" : "s"}${requestPart}`);
    }
    lines.push("");
    // --- Key Work ---
    // Collect unique completed + learned entries across all sessions
    const keyWorkItems = new Set();
    for (const s of sessions) {
        if (s.completed && s.completed.trim()) {
            for (const item of s.completed.split(/\n+/)) {
                const trimmed = item.trim();
                if (trimmed)
                    keyWorkItems.add(trimmed);
            }
        }
        if (s.learned && s.learned.trim()) {
            for (const item of s.learned.split(/\n+/)) {
                const trimmed = item.trim();
                if (trimmed)
                    keyWorkItems.add(trimmed);
            }
        }
    }
    lines.push("## Key Work");
    lines.push("");
    if (keyWorkItems.size > 0) {
        for (const item of keyWorkItems) {
            lines.push(`- ${item}`);
        }
    }
    else {
        lines.push("_No completed or learned items recorded._");
    }
    lines.push("");
    // --- Observations ---
    // Collect all observation titles across all sessions
    lines.push("## Observations");
    lines.push("");
    const allObservations = [];
    for (const s of sessions) {
        for (const obs of s.observations) {
            if (obs.title && obs.title.trim()) {
                allObservations.push({ title: obs.title.trim(), type: obs.type });
            }
        }
    }
    // Deduplicate by title
    const seenTitles = new Set();
    const uniqueObservations = allObservations.filter(({ title }) => {
        if (seenTitles.has(title))
            return false;
        seenTitles.add(title);
        return true;
    });
    if (uniqueObservations.length > 0) {
        for (const { title, type } of uniqueObservations) {
            const emoji = observationEmoji(type);
            lines.push(`- ${emoji} ${title}`);
        }
    }
    else {
        lines.push("_No observations recorded._");
    }
    lines.push("");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Determine target path for MEMORY.md
// ---------------------------------------------------------------------------
function targetMemoryPath(project) {
    const { projectPath, projectSlug } = project;
    if (projectPath && fs.existsSync(projectPath)) {
        return path.join(projectPath, ".claude", "memory", "MEMORY.md");
    }
    // Project path does not exist → archive
    return path.join(ARCHIVE_DIR, `${projectSlug}-MEMORY.md`);
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    const manifestPath = path.join(MIGRATION_DIR, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
        console.error(`ERROR: manifest.json not found at ${manifestPath}`);
        console.error("Run extract.ts first: bun run migrate/extract.ts");
        process.exit(1);
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    catch (err) {
        console.error(`ERROR: Failed to parse manifest.json: ${err.message}`);
        process.exit(1);
    }
    const eligibleProjects = manifest.projects.filter((p) => p.sessionCount > 2);
    const totalEligible = eligibleProjects.length;
    console.log(`Manifest: ${manifest.projects.length} projects total, ${totalEligible} eligible (>2 sessions)`);
    console.log("");
    let generated = 0;
    let skipped = 0;
    for (const entry of eligibleProjects) {
        const slug = entry.slug;
        // Skip orphan slug
        if (slug === "orphans") {
            console.log(`Skipping orphans (no meaningful project)`);
            skipped++;
            continue;
        }
        // Resolve the JSON file path — always derived from the slug
        const jsonFilePath = path.join(MIGRATION_DIR, `${slug}.json`);
        if (!fs.existsSync(jsonFilePath)) {
            console.warn(`WARNING: Project JSON not found: ${jsonFilePath} — skipping '${slug}'`);
            skipped++;
            continue;
        }
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(jsonFilePath, "utf-8"));
        }
        catch (err) {
            console.warn(`[generate-memory] Skipping corrupt/unreadable project file: ${jsonFilePath}`, err.message);
            skipped++;
            continue;
        }
        const project = normaliseProject(raw, slug);
        if (!project) {
            console.warn(`[generate-memory] Could not parse project data for '${slug}' — skipping`);
            skipped++;
            continue;
        }
        // Override projectName from manifest if available and project doesn't have one
        if (entry.name && project.projectName === slug) {
            project.projectName = entry.name;
        }
        const memoryPath = targetMemoryPath(project);
        // Idempotent: skip if MEMORY.md already exists
        if (fs.existsSync(memoryPath)) {
            console.log(`Skipping ${project.projectName} — MEMORY.md already exists at ${memoryPath}`);
            skipped++;
            continue;
        }
        console.log(`Generating MEMORY.md for ${project.projectName}...`);
        const content = buildMemoryMd(project);
        try {
            fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
            fs.writeFileSync(memoryPath, content, "utf-8");
            console.log(`  Written: ${memoryPath}`);
            generated++;
        }
        catch (err) {
            console.warn(`[generate-memory] Failed to write ${memoryPath}: ${err.message}`);
            skipped++;
        }
    }
    console.log("");
    console.log(`Generated MEMORY.md files for ${generated} of ${totalEligible} eligible projects.`);
    if (skipped > 0) {
        console.log(`Skipped: ${skipped} (already exists, missing JSON, or orphan)`);
    }
}
main();
