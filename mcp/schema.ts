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

  return db;
}

export const DB_PATH = path.join(
  os.homedir(),
  '.claude-memory',
  'memory.db'
);
