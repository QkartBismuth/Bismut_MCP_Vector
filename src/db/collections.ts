import { log, McpToolError } from "../logger.js";
import { nowMs } from "../util/text.js";
import type { VectorDatabase } from "./database.js";

export interface Collection {
  id: number;
  name: string;
  dim: number;
  model: string;
  dtype: string;
  provider: string;
  query_prefix: string;
  passage_prefix: string;
  normalize: number;
  created_at: number;
  meta: string | null;
}

export interface EmbeddingSpec {
  dim: number;
  model: string;
  dtype: string;
  provider: string;
  queryPrefix: string;
  passagePrefix: string;
  normalize: boolean;
}

export function vecTableName(collectionId: number): string {
  return `vec_c_${collectionId}`;
}

export function vecTableSql(collectionId: number, dim: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS "${vecTableName(collectionId)}" USING vec0(embedding float[${dim}] distance_metric=cosine, doc_id integer)`;
}

const VALID_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function assertValidCollectionName(name: string): string {
  if (!VALID_NAME.test(name)) {
    throw new McpToolError(
      "invalid_collection",
      `Invalid collection name "${name}". Use 1-64 chars from [A-Za-z0-9._-].`,
    );
  }
  return name;
}

export function getCollection(db: VectorDatabase, name: string): Collection | undefined {
  return db.get<Collection>("SELECT * FROM collections WHERE name = ?", name);
}

export function requireCollection(db: VectorDatabase, name: string): Collection {
  const found = getCollection(db, name);
  if (!found) {
    throw new McpToolError(
      "collection_not_found",
      `Collection "${name}" does not exist. Create it by indexing into it, or call list_collections.`,
    );
  }
  return found;
}

export function listCollections(db: VectorDatabase): Collection[] {
  return db.all<Collection>("SELECT * FROM collections ORDER BY name");
}

export function collectionStats(
  db: VectorDatabase,
  collection: Collection,
): { documents: number; chunks: number; bytes: number; oldest: number | null; newest: number | null } {
  return db.get<{
    documents: number;
    chunks: number;
    bytes: number;
    oldest: number | null;
    newest: number | null;
  }>(
    `SELECT count(*) AS documents,
            coalesce(sum(chunk_count), 0) AS chunks,
            coalesce(sum(size), 0) AS bytes,
            min(indexed_at) AS oldest,
            max(indexed_at) AS newest
     FROM documents WHERE collection_id = ?`,
    collection.id,
  ) ?? { documents: 0, chunks: 0, bytes: 0, oldest: null, newest: null };
}

export function createCollection(
  db: VectorDatabase,
  name: string,
  spec: EmbeddingSpec,
  meta?: Record<string, unknown>,
): Collection {
  assertValidCollectionName(name);

  const existing = getCollection(db, name);
  if (existing) {
    if (existing.model !== spec.model || existing.dim !== spec.dim) {
      throw new McpToolError(
        "collection_model_mismatch",
        `Collection "${name}" already uses model "${existing.model}" (dim ${existing.dim}). ` +
          `Requested "${spec.model}" (dim ${spec.dim}). Use a different collection name, or delete the collection first.`,
      );
    }
    return existing;
  }

  return db.transaction(() => {
    const inserted = db
      .prepare(
        `INSERT INTO collections (name, dim, model, dtype, provider, query_prefix, passage_prefix, normalize, created_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        spec.dim,
        spec.model,
        spec.dtype,
        spec.provider,
        spec.queryPrefix,
        spec.passagePrefix,
        spec.normalize ? 1 : 0,
        nowMs(),
        meta ? JSON.stringify(meta) : null,
      );

    const id = Number(inserted.lastInsertRowid);
    db.exec(vecTableSql(id, spec.dim));
    log.info("created collection", name, `dim=${spec.dim}`, `model=${spec.model}`);
    return requireCollection(db, name);
  });
}

export function dropCollection(db: VectorDatabase, name: string): boolean {
  const found = getCollection(db, name);
  if (!found) return false;
  return db.transaction(() => {
    db.prepare("DELETE FROM collections WHERE id = ?").run(found.id);
    db.exec(`DROP TABLE IF EXISTS "${vecTableName(found.id)}"`);
    return true;
  });
}
