import { log } from "../logger.js";
import { nowMs, toPosix } from "../util/text.js";
import { vecTableName, type Collection } from "./collections.js";
import type { SqlParam, VectorDatabase } from "./database.js";
import { floatToBlob } from "./database.js";

export interface DocumentRecord {
  id: number;
  collection_id: number;
  uri: string;
  title: string | null;
  language: string | null;
  kind: string;
  mtime: number | null;
  size: number | null;
  content_hash: string;
  chunk_count: number;
  indexed_at: number;
  meta: string | null;
}

export interface ChunkInput {
  text: string;
  embedText: string;
  tokens: number;
  startLine: number | null;
  endLine: number | null;
}

export interface StoredChunk {
  id: number;
  document_id: number;
  ordinal: number;
  start_line: number | null;
  end_line: number | null;
  text: string;
  tokens: number | null;
}

export interface SearchHit {
  chunk_id: number;
  document_id: number;
  ordinal: number;
  score: number;
  distance: number;
  uri: string;
  title: string | null;
  language: string | null;
  kind: string;
  start_line: number | null;
  end_line: number | null;
  text: string;
  tokens: number | null;
}

export interface SearchOptions {
  limit: number;
  uriPrefixes?: string[];
  uriExact?: string[];
  languages?: string[];
  kinds?: string[];
  documentIds?: number[];
  minScore?: number;
}

export function findDocument(
  db: VectorDatabase,
  collectionId: number,
  uri: string,
): DocumentRecord | undefined {
  return db.get<DocumentRecord>("SELECT * FROM documents WHERE collection_id = ? AND uri = ?", collectionId, uri);
}

export function listDocuments(
  db: VectorDatabase,
  collectionId: number,
  opts: { uriPrefix?: string; limit: number; offset: number },
): { documents: DocumentRecord[]; total: number } {
  const where: string[] = ["collection_id = ?"];
  const params: SqlParam[] = [collectionId];
  if (opts.uriPrefix) {
    where.push("uri LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(opts.uriPrefix)}%`);
  }
  const clause = where.join(" AND ");
  const total = db.scalar<number>(`SELECT count(*) FROM documents WHERE ${clause}`, ...params) ?? 0;
  const documents = db.all<DocumentRecord>(
    `SELECT * FROM documents WHERE ${clause} ORDER BY uri LIMIT ? OFFSET ?`,
    ...params,
    opts.limit,
    opts.offset,
  );
  return { documents, total };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface UpsertDocumentInput {
  collectionId: number;
  uri: string;
  title: string | null;
  language: string | null;
  kind: string;
  mtime: number | null;
  size: number | null;
  contentHash: string;
  meta?: Record<string, unknown> | null;
}

export interface UpsertResult {
  documentId: number;
  reused: boolean;
  chunkCount: number;
}

export function indexDocument(
  db: VectorDatabase,
  collection: Collection,
  input: UpsertDocumentInput,
  chunks: ChunkInput[],
  vectors: Float32Array[],
): UpsertResult {
  if (chunks.length !== vectors.length) {
    throw new Error(`Chunk/vector mismatch: ${chunks.length} chunks vs ${vectors.length} vectors`);
  }

  return db.transaction(() => {
    const existing = findDocument(db, collection.id, input.uri);
    let documentId: number;
    let reused = false;

    if (existing) {
      if (existing.content_hash === input.contentHash) {
        reused = true;
        documentId = existing.id;
      } else {
        deleteDocumentChunks(db, collection.id, existing.id);
        db.prepare("UPDATE documents SET title = ?, language = ?, kind = ?, mtime = ?, size = ?, content_hash = ?, indexed_at = ?, meta = ? WHERE id = ?")
          .run(
            input.title,
            input.language,
            input.kind,
            input.mtime,
            input.size,
            input.contentHash,
            nowMs(),
            input.meta ? JSON.stringify(input.meta) : null,
            existing.id,
          );
        documentId = existing.id;
      }
    } else {
      const inserted = db
        .prepare(
          `INSERT INTO documents (collection_id, uri, title, language, kind, mtime, size, content_hash, chunk_count, indexed_at, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          collection.id,
          input.uri,
          input.title,
          input.language,
          input.kind,
          input.mtime,
          input.size,
          input.contentHash,
          nowMs(),
          input.meta ? JSON.stringify(input.meta) : null,
        );
      documentId = Number(inserted.lastInsertRowid);
    }

    if (reused) {
      db.prepare("UPDATE documents SET title = ?, language = ?, mtime = ?, size = ?, indexed_at = ? WHERE id = ?")
        .run(input.title, input.language, input.mtime, input.size, nowMs(), documentId);
      return { documentId, reused: true, chunkCount: existing?.chunk_count ?? 0 };
    }

    const table = vecTableName(collection.id);
    const insertChunk = db.prepare(
      "INSERT INTO chunks (document_id, ordinal, start_line, end_line, text, embed_text, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertVector = db.prepare(`INSERT INTO "${table}" (rowid, embedding, doc_id) VALUES (?, ?, ?)`);

    let inserted = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as ChunkInput;
      const vector = vectors[i] as Float32Array;
      const res = insertChunk.run(
        documentId,
        i,
        chunk.startLine,
        chunk.endLine,
        chunk.text,
        chunk.embedText,
        chunk.tokens,
      );
      const chunkId = Number(res.lastInsertRowid);
      insertVector.run(BigInt(chunkId), floatToBlob(vector), BigInt(documentId));
      inserted += 1;
    }

    db.prepare("UPDATE documents SET chunk_count = ? WHERE id = ?").run(inserted, documentId);

    return { documentId, reused: false, chunkCount: inserted };
  });
}

export function storeVectorsInCache(
  db: VectorDatabase,
  model: string,
  hashes: string[],
  vectors: Float32Array[],
): void {
  if (hashes.length === 0) return;
  db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO embeddings_cache (content_hash, model, dim, vector, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(content_hash, model) DO UPDATE SET vector = excluded.vector, dim = excluded.dim`,
    );
    const ts = nowMs();
    for (let i = 0; i < hashes.length; i++) {
      const v = vectors[i] as Float32Array;
      stmt.run(hashes[i] as string, model, v.length, new Uint8Array(v.buffer, v.byteOffset, v.byteLength), ts);
    }
  });
}

export function lookupCachedVector(
  db: VectorDatabase,
  model: string,
  hash: string,
): Float32Array | undefined {
  const row = db.get<{ vector: Uint8Array }>(
    "SELECT vector FROM embeddings_cache WHERE content_hash = ? AND model = ?",
    hash,
    model,
  );
  if (!row) return undefined;
  const buf = row.vector;
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return new Float32Array(bytes.buffer);
}

export function deleteDocumentChunks(db: VectorDatabase, collectionId: number, documentId: number): void {
  const table = vecTableName(collectionId);
  const rows = db.prepare("SELECT id FROM chunks WHERE document_id = ?").all(documentId) as {
    id: number;
  }[];
  if (rows.length > 0) {
    const delVec = db.prepare(`DELETE FROM "${table}" WHERE rowid = ?`);
    for (const row of rows) delVec.run(BigInt(row.id));
  }
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
}

export function deleteDocuments(
  db: VectorDatabase,
  collection: Collection,
  filter: { ids?: number[]; uris?: string[]; uriPrefixes?: string[] },
): number {
  const where: string[] = ["collection_id = ?"];
  const params: SqlParam[] = [collection.id];
  if (filter.ids?.length) {
    where.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
    params.push(...filter.ids.map((v) => v));
  }
  if (filter.uris?.length) {
    where.push(`uri IN (${filter.uris.map(() => "?").join(", ")})`);
    params.push(...filter.uris);
  }
  if (filter.uriPrefixes?.length) {
    where.push(`(${filter.uriPrefixes.map(() => "uri LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...filter.uriPrefixes.map((p) => `${escapeLike(p)}%`));
  }
  const clause = where.join(" AND ");
  const docs = db.all<{ id: number }>(`SELECT id FROM documents WHERE ${clause}`, ...params);
  return db.transaction(() => {
    for (const doc of docs) {
      deleteDocumentChunks(db, collection.id, doc.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
    }
    return docs.length;
  });
}

export function pruneMissingDocuments(
  db: VectorDatabase,
  collection: Collection,
  rootPrefix: string,
  presentUris: Set<string>,
): string[] {
  const rows = db
    .prepare("SELECT id, uri FROM documents WHERE collection_id = ? AND kind = 'file' AND uri LIKE ? ESCAPE '\\'")
    .all(collection.id, `${escapeLike(rootPrefix)}%`) as { id: number; uri: string }[];
  const stale = rows.filter((r) => !presentUris.has(r.uri));
  if (stale.length === 0) return [];
  return db.transaction(() => {
    for (const row of stale) {
      deleteDocumentChunks(db, collection.id, row.id);
      db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
    }
    log.debug("pruned stale documents", stale.length);
    return stale.map((r) => r.uri);
  });
}

const MAX_DOC_ID_CLAUSE = 4000;

export function resolveDocumentIds(
  db: VectorDatabase,
  collectionId: number,
  opts: Pick<SearchOptions, "uriPrefixes" | "uriExact" | "languages" | "kinds" | "documentIds">,
): number[] | undefined {
  const hasFilter =
    (opts.uriPrefixes?.length ?? 0) > 0 ||
    (opts.uriExact?.length ?? 0) > 0 ||
    (opts.languages?.length ?? 0) > 0 ||
    (opts.kinds?.length ?? 0) > 0 ||
    (opts.documentIds?.length ?? 0) > 0;

  if (!hasFilter) return undefined;

  const where: string[] = ["collection_id = ?"];
  const params: SqlParam[] = [collectionId];

  if (opts.documentIds?.length) {
    where.push(`id IN (${opts.documentIds.map(() => "?").join(", ")})`);
    params.push(...opts.documentIds);
  }
  if (opts.uriExact?.length) {
    where.push(`uri IN (${opts.uriExact.map(() => "?").join(", ")})`);
    params.push(...opts.uriExact);
  }
  if (opts.uriPrefixes?.length) {
    where.push(`(${opts.uriPrefixes.map(() => "uri LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...opts.uriPrefixes.map((p) => `${escapeLike(p)}%`));
  }
  if (opts.languages?.length) {
    where.push(`language IN (${opts.languages.map(() => "?").join(", ")})`);
    params.push(...opts.languages);
  }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    params.push(...opts.kinds);
  }

  const rows = db.all<{ id: number }>(
    `SELECT id FROM documents WHERE ${where.join(" AND ")} LIMIT ${MAX_DOC_ID_CLAUSE}`,
    ...params,
  );
  return rows.map((r) => r.id);
}

export function search(
  db: VectorDatabase,
  collection: Collection,
  queryVector: Float32Array,
  opts: SearchOptions,
): SearchHit[] {
  const table = vecTableName(collection.id);
  const queryBlob = new Uint8Array(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
  const k = Math.max(1, Math.min(opts.limit, 1000));

  const docIds = resolveDocumentIds(db, collection.id, opts);
  if (docIds !== undefined && docIds.length === 0) {
    log.debug("search: filters matched no documents", JSON.stringify(opts));
    return [];
  }

  const vecClauses: string[] = [];
  const params: SqlParam[] = [queryBlob, k];

  if (docIds !== undefined) {
    vecClauses.push(`v.doc_id IN (${docIds.map(() => "?").join(", ")})`);
    params.push(...docIds.map((v) => BigInt(v)));
  }

  const postClauses: string[] = [];
  if (opts.uriExact?.length) {
    postClauses.push(`d.uri IN (${opts.uriExact.map(() => "?").join(", ")})`);
    params.push(...opts.uriExact);
  }
  if (opts.uriPrefixes?.length) {
    postClauses.push(`(${opts.uriPrefixes.map(() => "d.uri LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...opts.uriPrefixes.map((p) => `${escapeLike(p)}%`));
  }
  if (opts.languages?.length) {
    postClauses.push(`d.language IN (${opts.languages.map(() => "?").join(", ")})`);
    params.push(...opts.languages);
  }
  if (opts.kinds?.length) {
    postClauses.push(`d.kind IN (${opts.kinds.map(() => "?").join(", ")})`);
    params.push(...opts.kinds);
  }

  const where = [...vecClauses, ...postClauses].map((c) => ` AND ${c}`).join("");

  const sql =
    `SELECT c.id AS chunk_id, c.document_id, c.ordinal, c.start_line, c.end_line, c.text, c.tokens,
            v.distance,
            d.uri, d.title, d.language, d.kind
     FROM "${table}" v
     JOIN chunks c ON c.id = v.rowid
     JOIN documents d ON d.id = c.document_id
     WHERE v.embedding MATCH ? AND k = ?${where}
     ORDER BY v.distance`;

  const rows = db.all<Omit<SearchHit, "score"> & { distance: number }>(sql, ...params);

  const hits: SearchHit[] = rows.map((r) => ({
    chunk_id: r.chunk_id,
    document_id: r.document_id,
    ordinal: r.ordinal,
    score: 1 - r.distance,
    distance: r.distance,
    uri: toPosix(r.uri),
    title: r.title,
    language: r.language,
    kind: r.kind,
    start_line: r.start_line,
    end_line: r.end_line,
    text: r.text,
    tokens: r.tokens,
  }));

  return opts.minScore === undefined ? hits : hits.filter((h) => h.score >= opts.minScore!);
}

export function getChunksAround(
  db: VectorDatabase,
  documentId: number,
  centerOrdinal: number,
  before: number,
  after: number,
): StoredChunk[] {
  return db.all<StoredChunk>(
    `SELECT id, document_id, ordinal, start_line, end_line, text, tokens
       FROM chunks
       WHERE document_id = ? AND ordinal BETWEEN ? AND ?
       ORDER BY ordinal`,
    documentId,
    centerOrdinal - before,
    centerOrdinal + after,
  );
}

export function getDocumentChunk(
  db: VectorDatabase,
  documentId: number,
  ordinal: number,
): StoredChunk | undefined {
  return db.get<StoredChunk>(
    `SELECT id, document_id, ordinal, start_line, end_line, text, tokens
       FROM chunks WHERE document_id = ? AND ordinal = ?`,
    documentId,
    ordinal,
  );
}

export function getDocumentChunks(
  db: VectorDatabase,
  documentId: number,
  startOrdinal: number,
  limit: number,
): StoredChunk[] {
  return db.all<StoredChunk>(
    `SELECT id, document_id, ordinal, start_line, end_line, text, tokens
       FROM chunks WHERE document_id = ? AND ordinal >= ? ORDER BY ordinal LIMIT ?`,
    documentId,
    startOrdinal,
    limit,
  );
}

export function databaseStats(db: VectorDatabase): {
  collections: number;
  documents: number;
  chunks: number;
  cacheEntries: number;
} {
  return {
    collections: db.scalar<number>("SELECT count(*) FROM collections") ?? 0,
    documents: db.scalar<number>("SELECT count(*) FROM documents") ?? 0,
    chunks: db.scalar<number>("SELECT count(*) FROM chunks") ?? 0,
    cacheEntries: db.scalar<number>("SELECT count(*) FROM embeddings_cache") ?? 0,
  };
}
