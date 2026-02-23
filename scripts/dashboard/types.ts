/**
 * Shared types for the Engram Dashboard.
 */

export interface DaemonInfo {
  running: boolean;
  pid: number | null;
  uptimeMs: number | null;
  rssMB: number | null;
  rssLimitMB: number;
  embedFailures: number;
  api429Errors: number;
  sessionCount: number;
  recollectionCount: number;
}

export interface ProjectCount {
  name: string;
  count: number;
}

export interface ImportanceCount {
  importance: string;
  count: number;
}

export interface EpisodeStats {
  total: number;
  schemaVersion: number;
  byProject: ProjectCount[];
  byImportance: ImportanceCount[];
  chunkCount: number;
  cacheCount: number;
}

export interface SessionInfo {
  sessionId: string;
  byteOffset: number;
  messagesSinceExtraction: number;
  lastExtractedAt: number;
  hasRecollection: boolean;
}

export interface RecentExtraction {
  id: string;
  summary: string;
  importance: string;
  createdAt: number;
  project: string | null;
}

export interface DashboardData {
  daemon: DaemonInfo;
  episodes: EpisodeStats;
  sessions: SessionInfo[];
  recentExtractions: RecentExtraction[];
  logTail: string[];
}
