import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { log } from "../logger.js";
import type { Config } from "../config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE,
  dim            INTEGER NOT NULL,
  model          TEXT    NOT NULL,
  dtype          TEXT    NOT NULL,
  provider       TEXT    NOT NULL,
  query_prefix   TEXT    NOT NULL DEFAULT '',
  passage_prefix TEXT    NOT NULL DEFAULT '',
  normalize      INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  meta           TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  uri           TEXT    NOT NULL,
  title         TEXT,
  language      TEXT,
  kind          TEXT    NOT NULL DEFAULT 'file',
  mtime         INTEGER,
  size          INTEGER,
  content_hash  TEXT    NOT NULL,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL,
  meta          TEXT,
  UNIQUE(collection_id, uri)
);

CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents(collection_id);
CREATE INDEX IF NOT EXISTS documents_uri_idx       ON documents(uri);
CREATE INDEX IF NOT EXISTS documents_hash_idx      ON documents(collection_id, content_hash);

CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  start_line  INTEGER,
  end_line    INTEGER,
  text        TEXT    NOT NULL,
  embed_text  TEXT    NOT NULL,
  tokens      INTEGER
);

CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id, ordinal);

CREATE TABLE IF NOT EXISTS embeddings_cache (
  content_hash TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  dim          INTEGER NOT NULL,
  vector       BLOB    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (content_hash, model)
) WITHOUT ROWID;
`;

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

type Stmt = {
  all(...params: SqlParam[]): unknown[];
  get(...params: SqlParam[]): unknown;
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

export class VectorDatabase {
  readonly db: DatabaseSync;
  private readonly stmtCache = new Map<string, Stmt>();
  private transactionDepth = 0;

  constructor(config: Config) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    fs.mkdirSync(config.cacheDir, { recursive: true });

    this.db = new DatabaseSync(config.dbPath, { allowExtension: true });
    this.db.loadExtension(getLoadablePath());

    this.exec("PRAGMA journal_mode = WAL");
    this.exec("PRAGMA synchronous = NORMAL");
    this.exec("PRAGMA foreign_keys = ON");
    this.exec("PRAGMA busy_timeout = 5000");
    this.exec("PRAGMA temp_store = MEMORY");

    this.exec(SCHEMA);
    log.debug("database ready", config.dbPath);
  }

  prepare(sql: string): Stmt {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql) as unknown as Stmt;
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    const row = this.prepare(sql).get(...params);
    return (row as T | undefined) ?? undefined;
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const result = this.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.transactionDepth += 1;
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.exec("ROLLBACK");
      } catch (rollbackErr) {
        log.error("rollback failed", rollbackErr);
      }
      throw err;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  scalar<T = unknown>(sql: string, ...params: SqlParam[]): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, ...params);
    if (!row) return undefined;
    const keys = Object.keys(row);
    return keys.length > 0 ? (row[keys[0] as string] as T) : undefined;
  }

  close(): void {
    this.stmtCache.clear();
    try {
      this.db.close();
    } catch (err) {
      log.debug("close failed", err);
    }
  }
}

export function floatToBlob(values: Float32Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}
