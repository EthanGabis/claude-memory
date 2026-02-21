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

  return db;
}

export const DB_PATH = path.join(
  os.homedir(),
  '.claude-memory',
  'memory.db'
);
