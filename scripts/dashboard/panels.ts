/**
 * Panel renderers for the Engram Dashboard.
 * Each function takes DashboardData and returns a blessed-tag formatted string.
 */

import type { DashboardData } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const s = Math.floor(delta / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function escapeTags(s: string): string {
  return s.replace(/\{/g, '\\{');
}

function progressBar(current: number, max: number, width: number): string {
  const ratio = Math.min(current / max, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ---------------------------------------------------------------------------
// Panel renderers
// ---------------------------------------------------------------------------

export function renderHealth(data: DashboardData): string {
  const d = data.daemon;
  const lines: string[] = [];

  // Status + uptime
  if (d.running) {
    const uptime = d.uptimeMs != null ? ` (${formatUptime(d.uptimeMs)})` : '';
    lines.push(`Status: {green-fg}RUNNING{/}${uptime}`);
  } else {
    lines.push(`Status: {red-fg}STOPPED{/}`);
  }

  // PID
  lines.push(`PID: ${d.pid ?? '—'}`);

  // RSS bar
  const rss = d.rssMB ?? 0;
  const limit = d.rssLimitMB;
  let rssColor: string;
  if (rss < 350) rssColor = 'green';
  else if (rss <= 500) rssColor = 'yellow';
  else rssColor = 'red';
  const bar = progressBar(rss, limit, 16);
  lines.push(`RSS: {${rssColor}-fg}${rss}MB{/} / ${limit}MB [${bar}]`);

  // Error counts
  lines.push(`Embed fails: ${d.embedFailures} (session)`);
  lines.push(`429 errors: ${d.api429Errors} (session)`);

  // Session + recollection counts
  lines.push(`Sessions: ${d.sessionCount} tracked`);
  lines.push(`Recollections: ${d.recollectionCount}`);

  return lines.join('\n');
}

export function renderEpisodes(data: DashboardData): string {
  const e = data.episodes;
  const lines: string[] = [];

  lines.push(`Total: ${e.total}  Schema: v${e.schemaVersion}`);
  lines.push('');
  lines.push('By Project:');

  for (const p of e.byProject) {
    const padded = String(p.count).padStart(6);
    lines.push(`  ${p.name}${padded}`);
  }

  lines.push('');

  // Importance breakdown
  const highCount = e.byImportance.find(i => i.importance === 'high')?.count ?? 0;
  const normCount = e.byImportance.find(i => i.importance === 'normal')?.count ?? 0;
  lines.push(`High: ${highCount}  Normal: ${normCount}`);
  lines.push(`Chunks: ${e.chunkCount}  Cache: ${e.cacheCount}`);

  return lines.join('\n');
}

export function renderSessions(data: DashboardData): string {
  if (data.sessions.length === 0) {
    return '{yellow-fg}No active sessions{/}';
  }

  const lines: string[] = [];
  lines.push('Session    Offset       MsgQ  LastExtract  Recoll');

  const sorted = [...data.sessions].sort(
    (a, b) => b.lastExtractedAt - a.lastExtractedAt,
  );

  for (const s of sorted) {
    const id = s.sessionId.slice(0, 8);
    const offset = formatBytes(s.byteOffset).padEnd(11);
    const msgQ = String(s.messagesSinceExtraction).padEnd(6);
    const lastEx = (s.lastExtractedAt === 0 ? 'never' : formatRelativeTime(s.lastExtractedAt)).padEnd(13);
    const recoll = s.hasRecollection
      ? 'active'
      : '{red-fg}missing{/}';
    lines.push(`${id}  ${offset}${msgQ}${lastEx}${recoll}`);
  }

  return lines.join('\n');
}

export function renderExtractions(data: DashboardData): string {
  if (data.recentExtractions.length === 0) {
    return '{yellow-fg}No extractions yet{/}';
  }

  const lines: string[] = [];
  const items = data.recentExtractions.slice(0, 10);

  for (const ex of items) {
    const time = formatRelativeTime(ex.createdAt).padEnd(8);
    const badge =
      ex.importance === 'high'
        ? '{red-fg}[high]{/}'
        : '[norm]';
    // Truncate summary to a reasonable width
    const maxSummaryLen = 50;
    const rawSummary =
      ex.summary.length > maxSummaryLen
        ? ex.summary.slice(0, maxSummaryLen - 1) + '…'
        : ex.summary;
    lines.push(`${time} ${badge} ${escapeTags(rawSummary)}`);
  }

  return lines.join('\n');
}

export function renderLog(data: DashboardData): string {
  if (data.logTail.length === 0) {
    return '{yellow-fg}No log output{/}';
  }

  return data.logTail
    .map(line => {
      const escaped = escapeTags(line);
      const lower = line.toLowerCase();
      if (lower.includes('error') || lower.includes('failed')) {
        return `{red-fg}${escaped}{/}`;
      }
      if (lower.includes('warning')) {
        return `{yellow-fg}${escaped}{/}`;
      }
      return escaped;
    })
    .join('\n');
}
