import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { VectorDatabase } from "./db/database.js";
import {
  assertValidCollectionName,
  collectionStats,
  dropCollection,
  listCollections,
  requireCollection,
} from "./db/collections.js";
import {
  databaseStats,
  deleteDocuments,
  getChunksAround,
  listDocuments,
  search,
} from "./db/store.js";
import { EmbeddingService } from "./embedding/service.js";
import { LocalOnnxEmbeddingProvider } from "./embedding/local-onnx.js";
import { OpenAiCompatEmbeddingProvider } from "./embedding/openai-compat.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { IndexingPipeline } from "./ingest/pipeline.js";
import { Mutex } from "./util/async.js";
import { errorMessage, isMcpToolError, log, setLogLevel } from "./logger.js";
import { clamp, formatBytes, toPosix } from "./util/text.js";

export interface ServerContext {
  config: Config;
  db: VectorDatabase;
  embeddings: EmbeddingService;
  pipeline: IndexingPipeline;
  writeLock: Mutex;
}

function toolResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function errorResult(err: unknown) {
  const code = isMcpToolError(err) ? err.code : "internal_error";
  const payload = { ok: false, error: { code, message: errorMessage(err) } };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function wrap<TArgs>(handler: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    try {
      const result = await handler(args);
      return toolResult(result as Record<string, unknown>);
    } catch (err) {
      log.warn("tool failed", String(err));
      return errorResult(err);
    }
  };
}

function createProvider(config: Config): EmbeddingProvider {
  if (config.provider === "openai") {
    return new OpenAiCompatEmbeddingProvider(config);
  }
  return new LocalOnnxEmbeddingProvider(config);
}

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(fs.readFileSync(path.resolve(here, "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function createServer(config: Config): Promise<{ server: McpServer; context: ServerContext }> {
  setLogLevel(config.logLevel);

  const db = new VectorDatabase(config);
  const provider = createProvider(config);
  const embeddings = new EmbeddingService(config, provider, db);
  const pipeline = new IndexingPipeline(config, db, embeddings);
  const writeLock = new Mutex();

  const context: ServerContext = { config, db, embeddings, pipeline, writeLock };
  const server = new McpServer(
    { name: "bismut-vector-mcp", version: readPackageVersion() },
    {
      instructions: [
        "Local vector database for semantic code and document search. Runs fully offline:",
        "embeddings are computed in-process with a local ONNX model and stored in a SQLite file.",
        "",
        "Typical flow:",
        "1. `index_paths` to index a repository or documentation folder (safe to re-run, unchanged files are skipped).",
        "2. `search` to run semantic queries with optional path/language filters.",
        "3. `get_context` to expand a search hit into contiguous surrounding chunks when you need more detail.",
        "",
        "Prefer `search` with a path filter over guessing file names. Search results carry absolute",
        "file paths and line ranges, so they can be read directly with your file tools.",
      ].join("\n"),
    },
  );

  registerTools(server, context);

  return { server, context };
}

function registerTools(server: McpServer, ctx: ServerContext): void {
  const { config, db, embeddings, pipeline } = ctx;

  server.registerTool(
    "index_paths",
    {
      title: "Index files and folders",
      description:
        "Index files or directories into a vector collection for semantic search. Safe to re-run: files whose content " +
        "hash is unchanged are skipped. Honors .gitignore, skips binaries/oversized files, and uses language-aware " +
        "chunking (markdown sections, code symbols, prose paragraphs).",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Absolute or cwd-relative file/directory paths to index."),
        collection: z
          .string()
          .optional()
          .describe(`Target collection. Defaults to "${config.defaultCollection}".`),
        include: z
          .array(z.string())
          .optional()
          .describe('Glob filters, e.g. ["**/*.ts", "**/*.md"]. Empty means all supported files.'),
        exclude: z
          .array(z.string())
          .optional()
          .describe('Extra glob exclusions, e.g. ["**/fixtures/**", "**/*.test.ts"].'),
        recursive: z.boolean().optional().describe("Recurse into subdirectories. Default true."),
        force: z.boolean().optional().describe("Re-embed even if content is unchanged. Default false."),
        prune: z
          .boolean()
          .optional()
          .describe("Remove documents under these roots that no longer exist on disk. Default false."),
        respectGitignore: z.boolean().optional().describe("Honor .gitignore files. Default true."),
        maxFiles: z.number().int().positive().optional().describe("Safety cap on files per run. Default 5000."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{
      paths: string[];
      collection?: string;
      include?: string[];
      exclude?: string[];
      recursive?: boolean;
      force?: boolean;
      prune?: boolean;
      respectGitignore?: boolean;
      maxFiles?: number;
    }>(async (args) => {
      const collectionName = args.collection ?? config.defaultCollection;
      assertValidCollectionName(collectionName);

      const summary = await pipeline.indexPaths({
        paths: args.paths,
        collection: collectionName,
        include: args.include,
        exclude: args.exclude,
        recursive: args.recursive ?? true,
        force: args.force ?? false,
        prune: args.prune ?? false,
        respectGitignore: args.respectGitignore ?? true,
        followSymlinks: false,
        maxFiles: clamp(args.maxFiles ?? 5000, 1, 100_000),
        maxDepth: 24,
      });

      const collection = requireCollection(db, collectionName);
      const stats = collectionStats(db, collection);

      return {
        ok: true,
        ...summary,
        total_documents: stats.documents,
        total_chunks: stats.chunks,
        hint:
          summary.filesDiscovered === 0
            ? "No files matched. Check that paths exist and include/exclude globs are not too narrow."
            : `Indexed into collection "${collectionName}". Use search to query it.`,
      };
    }),
  );

  server.registerTool(
    "index_text",
    {
      title: "Index raw text",
      description:
        "Index arbitrary text (notes, snippets, memory entries, error logs, user-provided context) into a collection. " +
        "Use a stable `uri` to replace previous content for the same uri, or pass replace:false to append a new version.",
      inputSchema: {
        text: z.string().min(1).describe("The text content to index."),
        uri: z.string().min(1).describe("Stable identifier for this content, e.g. \"memory/2026-10-01.md\"."),
        collection: z.string().optional().describe(`Target collection. Defaults to "${config.defaultCollection}".`),
        title: z.string().optional().describe("Human-readable title used to enrich embeddings."),
        kind: z
          .string()
          .optional()
          .describe('Content kind for filtering: "text", "note", "memory", "log", "spec". Default "text".'),
        replace: z.boolean().optional().describe("Delete existing content for this uri first. Default true."),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary JSON metadata stored with the document."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{
      text: string;
      uri: string;
      collection?: string;
      title?: string | null;
      kind?: string;
      replace?: boolean;
      meta?: Record<string, unknown> | null;
    }>(async (args) => {
      const collectionName = args.collection ?? config.defaultCollection;
      assertValidCollectionName(collectionName);
      const result = await pipeline.indexText({
        text: args.text,
        uri: args.uri,
        collection: collectionName,
        title: args.title ?? null,
        kind: args.kind ?? "text",
        replace: args.replace ?? true,
        meta: args.meta ?? null,
      });
      return { ok: true, ...result };
    }),
  );

  server.registerTool(
    "search",
    {
      title: "Semantic search",
      description:
        "Run a semantic similarity query against indexed content. Returns ranked chunks with file path, line range, " +
        "score (cosine similarity, 1 = identical), and text. Supports narrowing by path prefix, exact path, language, " +
        "and content kind. Increase `limit` or use `get_context` when results look truncated.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language query or search phrase."),
        collection: z.string().optional().describe(`Collection to search. Defaults to "${config.defaultCollection}".`),
        limit: z.number().int().positive().max(200).optional().describe("Max results. Default 10."),
        uriPrefixes: z
          .array(z.string())
          .optional()
          .describe('Path prefixes to restrict to, e.g. ["src/", "docs/architecture"].'),
        uris: z.array(z.string()).optional().describe("Exact paths to restrict to."),
        languages: z.array(z.string()).optional().describe('Language filter, e.g. ["ru", "en"].'),
        kinds: z.array(z.string()).optional().describe('Content kind filter, e.g. ["file", "note"].'),
        minScore: z.number().optional().describe("Drop results below this cosine score, e.g. 0.3 to cut noise."),
        includeText: z.boolean().optional().describe("Include chunk text in the response. Default true."),
        maxCharsPerChunk: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Truncate each chunk's text to this many characters. Default 2000."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{
      query: string;
      collection?: string;
      limit?: number;
      uriPrefixes?: string[];
      uris?: string[];
      languages?: string[];
      kinds?: string[];
      minScore?: number;
      includeText?: boolean;
      maxCharsPerChunk?: number;
    }>(async (args) => {
      const collectionName = args.collection ?? config.defaultCollection;
      assertValidCollectionName(collectionName);

      const all = listCollections(db);
      const targets = all.length === 0 ? [] : all.filter((c) => c.name === collectionName || collectionName === "*");
      if (targets.length === 0) {
        return {
          ok: true,
          collection: collectionName,
          total: 0,
          results: [],
          hint:
            all.length === 0
              ? "No collections exist yet. Call index_paths or index_text first."
              : `Collection "${collectionName}" not found. Available: ${all.map((c) => c.name).join(", ")}. Use collection "*" to search all.`,
        };
      }

      const perCollectionLimit = clamp(args.limit ?? 10, 1, 200);
      const maxChars = args.maxCharsPerChunk ?? 2000;
      const includeText = args.includeText ?? true;

      const embeddingsForTargets = await Promise.all(
        targets.map(async (c) => {
          const [vector] = await embeddings.embedQueries([args.query]);
          const hits = search(db, c, vector as Float32Array, {
            limit: perCollectionLimit,
            uriPrefixes: args.uriPrefixes,
            uriExact: args.uris,
            languages: args.languages,
            kinds: args.kinds,
            minScore: args.minScore,
          });
          return hits;
        }),
      );

      const merged = embeddingsForTargets
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, perCollectionLimit)
        .map((hit) => ({
          score: Number(hit.score.toFixed(4)),
          uri: hit.uri,
          title: hit.title,
          language: hit.language,
          kind: hit.kind,
          start_line: hit.start_line,
          end_line: hit.end_line,
          chunk_id: hit.chunk_id,
          document_id: hit.document_id,
          ordinal: hit.ordinal,
          text: includeText ? hit.text.slice(0, maxChars) : undefined,
          text_truncated: includeText ? hit.text.length > maxChars : undefined,
        }));

      return {
        ok: true,
        collection: collectionName,
        collections_searched: targets.map((c) => c.name),
        total: merged.length,
        results: merged,
      };
    }),
  );

  server.registerTool(
    "get_context",
    {
      title: "Expand a search hit into surrounding context",
      description:
        "Return contiguous chunks around a search hit (by chunk_id or document_id + ordinal) so you can read a whole " +
        "function/section instead of an isolated fragment. Use after `search` when a result looks cut off.",
      inputSchema: {
        chunk_id: z.number().int().positive().optional().describe("Chunk id from a search result."),
        document_id: z.number().int().positive().optional().describe("Document id from a search result."),
        ordinal: z.number().int().nonnegative().optional().describe("Chunk ordinal from a search result."),
        before: z.number().int().nonnegative().optional().describe("Chunks to include before. Default 1."),
        after: z.number().int().nonnegative().optional().describe("Chunks to include after. Default 1."),
        maxChars: z.number().int().positive().optional().describe("Total character budget for returned text. Default 12000."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{
      chunk_id?: number;
      document_id?: number;
      ordinal?: number;
      before?: number;
      after?: number;
      maxChars?: number;
    }>(async (args) => {
      let documentId = args.document_id;
      let ordinal = args.ordinal;

      if (args.chunk_id !== undefined) {
        const row = db
          .prepare("SELECT document_id, ordinal FROM chunks WHERE id = ?")
          .get(args.chunk_id) as { document_id: number; ordinal: number } | undefined;
        if (!row) {
          return { ok: false, error: { code: "chunk_not_found", message: `Chunk ${args.chunk_id} does not exist.` } };
        }
        documentId = row.document_id;
        ordinal = row.ordinal;
      }

      if (documentId === undefined || ordinal === undefined) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "Provide chunk_id, or both document_id and ordinal.",
          },
        };
      }

      const doc = db
        .prepare("SELECT uri, title, language, kind FROM documents WHERE id = ?")
        .get(documentId) as { uri: string; title: string | null; language: string | null; kind: string } | undefined;
      if (!doc) {
        return { ok: false, error: { code: "document_not_found", message: `Document ${documentId} does not exist.` } };
      }

      const before = clamp(args.before ?? 1, 0, 50);
      const after = clamp(args.after ?? 1, 0, 50);
      const maxChars = clamp(args.maxChars ?? 12_000, 500, 200_000);

      const chunks = getChunksAround(db, documentId, ordinal, before, after);
      let budget = maxChars;
      const rendered: Array<Record<string, unknown>> = [];

      for (const chunk of chunks) {
        const slice = chunk.text.slice(0, budget);
        if (slice.length === 0) break;
        budget -= slice.length;
        rendered.push({
          chunk_id: chunk.id,
          ordinal: chunk.ordinal,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          text: slice,
        });
      }

      return {
        ok: true,
        uri: toPosix(doc.uri),
        title: doc.title,
        language: doc.language,
        kind: doc.kind,
        document_id: documentId,
        centered_on: ordinal,
        chunks_returned: rendered.length,
        chunks_available: chunks.length,
        truncated: budget <= 0,
        chunks: rendered,
      };
    }),
  );

  server.registerTool(
    "list_sources",
    {
      title: "List indexed documents",
      description:
        "List documents already indexed in a collection, with chunk counts and sizes. Use to check what is available " +
        "before searching, or to confirm an index_paths run covered what you expected.",
      inputSchema: {
        collection: z.string().optional().describe(`Collection name. Defaults to "${config.defaultCollection}".`),
        uriPrefix: z.string().optional().describe("Only list documents whose path starts with this prefix."),
        limit: z.number().int().positive().max(1000).optional().describe("Max documents to return. Default 100."),
        offset: z.number().int().nonnegative().optional().describe("Pagination offset. Default 0."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{ collection?: string; uriPrefix?: string; limit?: number; offset?: number }>(async (args) => {
      const collectionName = args.collection ?? config.defaultCollection;
      const collection = requireCollection(db, collectionName);
      const { documents, total } = listDocuments(db, collection.id, {
        uriPrefix: args.uriPrefix,
        limit: clamp(args.limit ?? 100, 1, 1000),
        offset: clamp(args.offset ?? 0, 0, 1_000_000),
      });

      return {
        ok: true,
        collection: collection.name,
        total,
        returned: documents.length,
        documents: documents.map((d) => ({
          document_id: d.id,
          uri: toPosix(d.uri),
          title: d.title,
          language: d.language,
          kind: d.kind,
          chunks: d.chunk_count,
          size_bytes: d.size,
          indexed_at: new Date(d.indexed_at).toISOString(),
        })),
      };
    }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "List all vector collections with their embedding model, dimensionality, document/chunk counts, and on-disk size.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<Record<string, never>>(async () => {
      const collections = listCollections(db);
      return {
        ok: true,
        database_path: config.dbPath,
        default_collection: config.defaultCollection,
        total: collections.length,
        collections: collections.map((c) => {
          const stats = collectionStats(db, c);
          return {
            name: c.name,
            model: c.model,
            provider: c.provider,
            dim: c.dim,
            documents: stats.documents,
            chunks: stats.chunks,
            source_bytes: stats.bytes,
            source_bytes_human: formatBytes(stats.bytes),
            created_at: new Date(c.created_at).toISOString(),
          };
        }),
      };
    }),
  );

  server.registerTool(
    "delete_sources",
    {
      title: "Delete indexed documents",
      description:
        "Remove documents from a collection by document id, exact uri, or path prefix. Vectors and chunks are deleted " +
        "together. This is irreversible and requires at least one selector.",
      inputSchema: {
        collection: z.string().optional().describe(`Collection name. Defaults to "${config.defaultCollection}".`),
        document_ids: z.array(z.number().int().positive()).optional().describe("Document ids to delete."),
        uris: z.array(z.string()).optional().describe("Exact document paths to delete."),
        uriPrefixes: z.array(z.string()).optional().describe("Delete all documents whose path starts with any prefix."),
        all: z.boolean().optional().describe('Delete the entire collection contents when true. Requires "all": true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap<{ collection?: string; document_ids?: number[]; uris?: string[]; uriPrefixes?: string[]; all?: boolean }>(
      async (args) => {
        const collectionName = args.collection ?? config.defaultCollection;
        const collection = requireCollection(db, collectionName);

        const hasSelector =
          args.all === true ||
          (args.document_ids?.length ?? 0) > 0 ||
          (args.uris?.length ?? 0) > 0 ||
          (args.uriPrefixes?.length ?? 0) > 0;

        if (!hasSelector) {
          return {
            ok: false,
            error: {
              code: "missing_selector",
              message: "Provide at least one of: document_ids, uris, uriPrefixes, or all:true.",
            },
          };
        }

        const before = collectionStats(db, collection);
        const deleted = await ctx.writeLock.runExclusive(() =>
          deleteDocuments(db, collection, {
            ids: args.document_ids,
            uris: args.uris,
            uriPrefixes: args.uriPrefixes,
          }),
        );
        const after = collectionStats(db, collection);

        return {
          ok: true,
          collection: collection.name,
          documents_deleted: deleted,
          documents_remaining: after.documents,
          chunks_removed: before.chunks - after.chunks,
        };
      },
    ),
  );

  server.registerTool(
    "drop_collection",
    {
      title: "Drop a collection",
      description:
        "Permanently delete an entire collection and all its vectors, chunks, and documents. Irreversible. " +
        "Prefer delete_sources when removing only some documents.",
      inputSchema: {
        collection: z.string().min(1).describe("Collection name to drop."),
        confirm: z
          .boolean()
          .describe('Must be true. Pass confirm:true to acknowledge permanent deletion.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    wrap<{ collection: string; confirm: boolean }>(async (args) => {
      assertValidCollectionName(args.collection);
      if (args.confirm !== true) {
        return {
          ok: false,
          error: {
            code: "confirmation_required",
            message: 'Pass confirm:true to drop a collection permanently.',
          },
        };
      }
      const existed = dropCollection(db, args.collection);
      return { ok: true, collection: args.collection, dropped: existed };
    }),
  );

  server.registerTool(
    "stats",
    {
      title: "Server and database statistics",
      description:
        "Show database path, embedding model/provider, collection count, and totals. Useful for verifying the server is " +
        "healthy and which model is active before diagnosing empty search results.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<Record<string, never>>(async () => {
      const totals = databaseStats(db);
      let dbSize = 0;
      try {
        dbSize = fs.statSync(config.dbPath).size;
      } catch {
        dbSize = 0;
      }

      let model: Record<string, unknown> = { loaded: false };
      try {
        model = embeddings.describe();
      } catch {
        model = { loaded: false, note: "Embedding model not loaded yet." };
      }

      return {
        ok: true,
        database_path: config.dbPath,
        database_size: formatBytes(dbSize),
        cache_dir: config.cacheDir,
        embedding: model,
        chunking: {
          target_tokens: config.chunkTokens,
          overlap_tokens: config.chunkOverlap,
          max_file_bytes: config.maxFileBytes,
        },
        totals,
        node_version: process.version,
        platform: `${process.platform}-${process.arch}`,
        cwd: toPosix(path.resolve(process.cwd())),
      };
    }),
  );

  server.registerTool(
    "get_chunk",
    {
      title: "Fetch a single chunk",
      description: "Return the full untruncated text of one chunk by its id, with its document metadata.",
      inputSchema: {
        chunk_id: z.number().int().positive().describe("Chunk id from a search result."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap<{ chunk_id: number }>(async (args) => {
      const row = db
        .prepare("SELECT id, document_id, ordinal, start_line, end_line, text, tokens FROM chunks WHERE id = ?")
        .get(args.chunk_id) as
        | { id: number; document_id: number; ordinal: number; start_line: number | null; end_line: number | null; text: string; tokens: number | null }
        | undefined;

      if (!row) {
        return { ok: false, error: { code: "chunk_not_found", message: `Chunk ${args.chunk_id} does not exist.` } };
      }

      const doc = db
        .prepare("SELECT uri, title, language, kind FROM documents WHERE id = ?")
        .get(row.document_id) as { uri: string; title: string | null; language: string | null; kind: string } | undefined;

      return {
        ok: true,
        chunk_id: row.id,
        document_id: row.document_id,
        ordinal: row.ordinal,
        start_line: row.start_line,
        end_line: row.end_line,
        tokens: row.tokens,
        uri: doc ? toPosix(doc.uri) : null,
        title: doc?.title ?? null,
        text: row.text,
      };
    }),
  );
}