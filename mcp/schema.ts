import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import os from 'node:os';

export function initDb(dbPath: string): Database {
  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO _meta VALUES ('schema_version', '1');

    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT NOT NULL UNIQUE,
      path       TEXT NOT NULL,
      layer      TEXT NOT NULL DEFAULT 'project',
      project    TEXT,
      start_line INTEGER,
      end_line   INTEGER,
      hash       TEXT NOT NULL,
      text       TEXT NOT NULL,
      embedding  BLOB,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash       TEXT PRIMARY KEY,
      embedding  BLOB NOT NULL,
      dims       INTEGER,
      updated_at INTEGER NOT NULL
    );

    -- IMPORTANT: FTS5 joins use physical rowid, NOT the id column.
    -- All search queries must use: WHERE chunks.rowid = fts_result.rowid
    -- Never join on chunks.id for FTS5 results.
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text,
      content='chunks',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);

  // --- Schema version 2 migration: episodes table ---
  const versionRow = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 1;

  if (currentVersion < 2) {
    const runV2Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS episodes (
            id            TEXT PRIMARY KEY,
            session_id    TEXT NOT NULL,
            project       TEXT,
            scope         TEXT NOT NULL DEFAULT 'project',
            summary       TEXT NOT NULL,
            entities      TEXT,
            importance    TEXT NOT NULL DEFAULT 'normal',
            source_type   TEXT NOT NULL DEFAULT 'auto',
            full_content  TEXT,
            embedding     BLOB,
            created_at    INTEGER NOT NULL,
            accessed_at   INTEGER NOT NULL,
            access_count  INTEGER NOT NULL DEFAULT 0
          );

          CREATE INDEX IF NOT EXISTS idx_episodes_scope ON episodes(scope, project);
          CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);

          -- IMPORTANT: FTS5 joins use physical rowid, NOT the id column.
          -- All search queries must use: WHERE episodes.rowid = fts_result.rowid
          -- Never join on episodes.id for FTS5 results.
          CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
            summary,
            content='episodes',
            content_rowid='rowid'
          );

          CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
            INSERT INTO episodes_fts(rowid, summary) VALUES (new.rowid, new.summary);
          END;

          CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
            INSERT INTO episodes_fts(episodes_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
          END;

          CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
            INSERT INTO episodes_fts(episodes_fts, rowid, summary) VALUES ('delete', old.rowid, old.summary);
            INSERT INTO episodes_fts(rowid, summary) VALUES (new.rowid, new.summary);
          END;

          UPDATE _meta SET value = '2' WHERE key = 'schema_version';
        `);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        throw err;
      }
    };

    try {
      runV2Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v2 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        // Re-check version in case other process completed it
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 2) {
          console.error('[schema] v2 migration completed by other process');
        } else {
          runV2Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 3 migration: add entities to FTS5 ---
  const v3Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v3Version = v3Row ? parseInt(v3Row.value, 10) : 1;

  if (v3Version < 3) {
    const runV3Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`
          DROP TRIGGER IF EXISTS episodes_ai;
          DROP TRIGGER IF EXISTS episodes_ad;
          DROP TRIGGER IF EXISTS episodes_au;
          DROP TABLE IF EXISTS episodes_fts;

          CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
            summary,
            entities,
            content='episodes',
            content_rowid='rowid'
          );

          CREATE TRIGGER episodes_ai AFTER INSERT ON episodes BEGIN
            INSERT INTO episodes_fts(rowid, summary, entities)
            VALUES (new.rowid, new.summary, COALESCE(new.entities, ''));
          END;

          CREATE TRIGGER episodes_ad AFTER DELETE ON episodes BEGIN
            INSERT INTO episodes_fts(episodes_fts, rowid, summary, entities)
            VALUES ('delete', old.rowid, old.summary, COALESCE(old.entities, ''));
          END;

          CREATE TRIGGER episodes_au AFTER UPDATE ON episodes BEGIN
            INSERT INTO episodes_fts(episodes_fts, rowid, summary, entities)
            VALUES ('delete', old.rowid, old.summary, COALESCE(old.entities, ''));
            INSERT INTO episodes_fts(rowid, summary, entities)
            VALUES (new.rowid, new.summary, COALESCE(new.entities, ''));
          END;

          INSERT INTO episodes_fts(rowid, summary, entities)
          SELECT rowid, summary, COALESCE(entities, '') FROM episodes;

          UPDATE _meta SET value = '3' WHERE key = 'schema_version';
        `);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        throw err;
      }
    };

    try {
      runV3Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v3 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        // Re-check version in case other process completed it
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 3) {
          console.error('[schema] v3 migration completed by other process');
        } else {
          runV3Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 4 migration: add graduated_at to episodes ---
  const v4Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v4Version = v4Row ? parseInt(v4Row.value, 10) : 1;

  if (v4Version < 4) {
    const runV4Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`ALTER TABLE episodes ADD COLUMN graduated_at INTEGER DEFAULT NULL`);
        db.exec(`UPDATE _meta SET value = '4' WHERE key = 'schema_version'`);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        if ((err as Error).message?.includes('duplicate column')) {
          // Column exists from a partial prior migration — just bump version atomically
          db.exec(`BEGIN EXCLUSIVE`);
          try {
            db.exec(`UPDATE _meta SET value = '4' WHERE key = 'schema_version'`);
            db.exec(`COMMIT`);
          } catch (innerErr) {
            try { db.exec(`ROLLBACK`); } catch {}
            throw innerErr;
          }
        } else {
          throw err;
        }
      }
    };

    try {
      runV4Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v4 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        // Re-check version in case other process completed it
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 4) {
          console.error('[schema] v4 migration completed by other process');
        } else {
          runV4Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 5 migration: projects table ---
  const v5Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v5Version = v5Row ? parseInt(v5Row.value, 10) : 1;

  if (v5Version < 5) {
    const runV5Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS projects (
            full_path   TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT,
            source      TEXT NOT NULL DEFAULT 'auto',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

          UPDATE _meta SET value = '5' WHERE key = 'schema_version';
        `);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        throw err;
      }
    };

    try {
      runV5Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v5 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 5) {
          console.error('[schema] v5 migration completed by other process');
        } else {
          runV5Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 6 migration: add parent_project to projects ---
  const v6Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v6Version = v6Row ? parseInt(v6Row.value, 10) : 1;

  if (v6Version < 6) {
    const runV6Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`ALTER TABLE projects ADD COLUMN parent_project TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project)`);
        db.exec(`UPDATE _meta SET value = '6' WHERE key = 'schema_version'`);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        if ((err as Error).message?.includes('duplicate column')) {
          // Column exists from a partial prior migration — just bump version and add index atomically
          db.exec(`BEGIN EXCLUSIVE`);
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_project)`);
            db.exec(`UPDATE _meta SET value = '6' WHERE key = 'schema_version'`);
            db.exec(`COMMIT`);
          } catch (innerErr) {
            try { db.exec(`ROLLBACK`); } catch {}
            throw innerErr;
          }
        } else {
          throw err;
        }
      }
    };

    try {
      runV6Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v6 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 6) {
          console.error('[schema] v6 migration completed by other process');
        } else {
          runV6Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 7 migration: add project_path to episodes and chunks ---
  const v7Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v7Version = v7Row ? parseInt(v7Row.value, 10) : 1;

  if (v7Version < 7) {
    const runV7Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`ALTER TABLE episodes ADD COLUMN project_path TEXT`);
        db.exec(`ALTER TABLE chunks ADD COLUMN project_path TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_project_path ON episodes(project_path)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_project_path ON chunks(project_path)`);
        db.exec(`
          UPDATE episodes SET project_path = (
            SELECT p.full_path FROM projects p WHERE p.name = episodes.project ORDER BY p.full_path LIMIT 1
          ) WHERE project IS NOT NULL AND project_path IS NULL
        `);
        db.exec(`
          UPDATE chunks SET project_path = (
            SELECT p.full_path FROM projects p WHERE p.name = chunks.project ORDER BY p.full_path LIMIT 1
          ) WHERE project IS NOT NULL AND project_path IS NULL
        `);
        db.exec(`UPDATE _meta SET value = '7' WHERE key = 'schema_version'`);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        if ((err as Error).message?.includes('duplicate column')) {
          // Column(s) exist from a partial prior migration — add indexes, backfill, and bump version atomically
          db.exec(`BEGIN EXCLUSIVE`);
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_project_path ON episodes(project_path)`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_project_path ON chunks(project_path)`);
            db.exec(`
              UPDATE episodes SET project_path = (
                SELECT p.full_path FROM projects p WHERE p.name = episodes.project ORDER BY p.full_path LIMIT 1
              ) WHERE project IS NOT NULL AND project_path IS NULL
            `);
            db.exec(`
              UPDATE chunks SET project_path = (
                SELECT p.full_path FROM projects p WHERE p.name = chunks.project ORDER BY p.full_path LIMIT 1
              ) WHERE project IS NOT NULL AND project_path IS NULL
            `);
            db.exec(`UPDATE _meta SET value = '7' WHERE key = 'schema_version'`);
            db.exec(`COMMIT`);
          } catch (innerErr) {
            try { db.exec(`ROLLBACK`); } catch {}
            throw innerErr;
          }
        } else {
          throw err;
        }
      }
    };

    try {
      runV7Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v7 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 7) {
          console.error('[schema] v7 migration completed by other process');
        } else {
          runV7Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 8 migration: add accessed_at index for vector pool query ---
  const v8Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v8Version = v8Row ? parseInt(v8Row.value, 10) : 1;

  if (v8Version < 8) {
    const runV8Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_accessed_at ON episodes(accessed_at DESC) WHERE embedding IS NOT NULL`);
        db.exec(`UPDATE _meta SET value = '8' WHERE key = 'schema_version'`);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        if ((err as Error).message?.includes('already exists')) {
          // Index exists from a partial prior migration — just bump version
          db.exec(`BEGIN EXCLUSIVE`);
          try {
            db.exec(`UPDATE _meta SET value = '8' WHERE key = 'schema_version'`);
            db.exec(`COMMIT`);
          } catch (innerErr) {
            try { db.exec(`ROLLBACK`); } catch {}
            throw innerErr;
          }
        } else {
          throw err;
        }
      }
    };

    try {
      runV8Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v8 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 8) {
          console.error('[schema] v8 migration completed by other process');
        } else {
          runV8Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 9 migration: beliefs table ---
  const v9Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v9Version = v9Row ? parseInt(v9Row.value, 10) : 1;

  if (v9Version < 9) {
    const runV9Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS beliefs (
            id                     TEXT PRIMARY KEY,
            statement              TEXT NOT NULL,
            subject                TEXT,
            predicate              TEXT,
            context                TEXT,
            timeframe              TEXT,
            confidence_alpha       REAL NOT NULL DEFAULT 1,
            confidence_beta        REAL NOT NULL DEFAULT 1,
            scope                  TEXT NOT NULL DEFAULT 'global',
            project                TEXT,
            project_path           TEXT,
            supporting_episodes    TEXT NOT NULL DEFAULT '[]',
            contradicting_episodes TEXT NOT NULL DEFAULT '[]',
            revision_history       TEXT NOT NULL DEFAULT '[]',
            -- INVARIANT: parent_belief_id forms a tree; cycles are forbidden
            parent_belief_id       TEXT,
            child_belief_ids       TEXT NOT NULL DEFAULT '[]',
            embedding              BLOB,
            status                 TEXT NOT NULL DEFAULT 'active',
            evidence_count         INTEGER NOT NULL DEFAULT 0,
            stability              REAL NOT NULL DEFAULT 1.0,
            created_at             INTEGER NOT NULL,
            updated_at             INTEGER NOT NULL,
            last_reinforced_at     INTEGER,
            last_accessed_at       INTEGER,
            access_count           INTEGER NOT NULL DEFAULT 0
          );

          CREATE VIRTUAL TABLE IF NOT EXISTS beliefs_fts USING fts5(
            statement, subject, predicate, context,
            content='beliefs',
            content_rowid='rowid'
          );

          CREATE TRIGGER IF NOT EXISTS beliefs_ai AFTER INSERT ON beliefs BEGIN
            INSERT INTO beliefs_fts(rowid, statement, subject, predicate, context)
            VALUES (new.rowid, new.statement, COALESCE(new.subject, ''), COALESCE(new.predicate, ''), COALESCE(new.context, ''));
          END;

          CREATE TRIGGER IF NOT EXISTS beliefs_ad AFTER DELETE ON beliefs BEGIN
            INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, subject, predicate, context)
            VALUES ('delete', old.rowid, old.statement, COALESCE(old.subject, ''), COALESCE(old.predicate, ''), COALESCE(old.context, ''));
          END;

          CREATE TRIGGER IF NOT EXISTS beliefs_au AFTER UPDATE ON beliefs BEGIN
            INSERT INTO beliefs_fts(beliefs_fts, rowid, statement, subject, predicate, context)
            VALUES ('delete', old.rowid, old.statement, COALESCE(old.subject, ''), COALESCE(old.predicate, ''), COALESCE(old.context, ''));
            INSERT INTO beliefs_fts(rowid, statement, subject, predicate, context)
            VALUES (new.rowid, new.statement, COALESCE(new.subject, ''), COALESCE(new.predicate, ''), COALESCE(new.context, ''));
          END;

          CREATE INDEX IF NOT EXISTS idx_beliefs_status ON beliefs(status);
          CREATE INDEX IF NOT EXISTS idx_beliefs_scope ON beliefs(scope);
          CREATE INDEX IF NOT EXISTS idx_beliefs_project_path ON beliefs(project_path);

          INSERT OR IGNORE INTO _meta (key, value) VALUES ('belief_consolidation_checkpoint', '0');

          UPDATE _meta SET value = '9' WHERE key = 'schema_version';
        `);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        throw err;
      }
    };

    try {
      runV9Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v9 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 9) {
          console.error('[schema] v9 migration completed by other process');
        } else {
          runV9Migration();
        }
      } else {
        throw err;
      }
    }
  }

  // --- Schema version 10 migration: add peak_confidence to beliefs ---
  const v10Row = db.query<{ value: string }, []>(
    `SELECT value FROM _meta WHERE key = 'schema_version'`
  ).get();
  const v10Version = v10Row ? parseInt(v10Row.value, 10) : 1;

  if (v10Version < 10) {
    const runV10Migration = () => {
      db.exec(`BEGIN EXCLUSIVE`);
      try {
        db.exec(`ALTER TABLE beliefs ADD COLUMN peak_confidence REAL DEFAULT NULL`);
        // Backfill peak_confidence for existing beliefs
        db.exec(`UPDATE beliefs SET peak_confidence = confidence_alpha / (confidence_alpha + confidence_beta) WHERE peak_confidence IS NULL`);
        db.exec(`UPDATE _meta SET value = '10' WHERE key = 'schema_version'`);
        db.exec(`COMMIT`);
      } catch (err) {
        try { db.exec(`ROLLBACK`); } catch {}
        if ((err as Error).message?.includes('duplicate column')) {
          db.exec(`BEGIN EXCLUSIVE`);
          try {
            db.exec(`UPDATE _meta SET value = '10' WHERE key = 'schema_version'`);
            db.exec(`COMMIT`);
          } catch (innerErr) {
            try { db.exec(`ROLLBACK`); } catch {}
            throw innerErr;
          }
        } else {
          throw err;
        }
      }
    };

    try {
      runV10Migration();
    } catch (err) {
      if ((err as Error).message?.includes('SQLITE_BUSY') || (err as Error).message?.includes('database is locked')) {
        console.error('[schema] v10 migration busy — retrying in 6s');
        Bun.sleepSync(6000);
        const recheck = db.query<{ value: string }, []>(
          `SELECT value FROM _meta WHERE key = 'schema_version'`
        ).get();
        if (recheck && parseInt(recheck.value, 10) >= 10) {
          console.error('[schema] v10 migration completed by other process');
        } else {
          runV10Migration();
        }
      } else {
        throw err;
      }
    }
  }

  return db;
}

export interface Belief {
  id: string;
  statement: string;
  subject: string | null;
  predicate: string | null;
  context: string | null;
  timeframe: string | null;
  confidence_alpha: number;
  confidence_beta: number;
  scope: string;
  project: string | null;
  project_path: string | null;
  supporting_episodes: string;
  contradicting_episodes: string;
  revision_history: string;
  parent_belief_id: string | null;
  child_belief_ids: string;
  embedding: Buffer | null;
  status: string;
  evidence_count: number;
  stability: number;
  created_at: number;
  updated_at: number;
  last_reinforced_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
  peak_confidence: number | null;
}

export const DB_PATH = path.join(
  os.homedir(),
  '.claude-memory',
  'memory.db'
);
