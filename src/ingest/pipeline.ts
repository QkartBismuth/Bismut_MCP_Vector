import path from "node:path";
import fs from "node:fs/promises";
import { chunkDocument, guessLanguage } from "../chunking/index.js";
import { summarizeMarkdown } from "../chunking/markdown.js";
import { languageForFile } from "../chunking/languages.js";
import type { ChunkOptions } from "../chunking/types.js";
import type { Collection } from "../db/collections.js";
import { createCollection, requireCollection } from "../db/collections.js";
import type { VectorDatabase } from "../db/database.js";
import { deleteDocuments, findDocument, indexDocument, pruneMissingDocuments } from "../db/store.js";
import type { EmbeddingService } from "../embedding/service.js";
import { chunkHash } from "../chunking/index.js";
import { McpToolError, log } from "../logger.js";
import { sha256, toPosix } from "../util/text.js";
import { Mutex } from "../util/async.js";
import type { Config } from "../config.js";
import { readFileContent } from "./readers.js";
import { discoverFiles } from "./walker.js";

export interface IndexPathsInput {
  paths: string[];
  collection: string;
  include?: string[];
  exclude?: string[];
  respectGitignore: boolean;
  followSymlinks: boolean;
  force: boolean;
  prune: boolean;
  maxFiles: number;
  maxDepth: number;
  recursive: boolean;
  progress?: (msg: string) => void;
}

export interface IndexSummary {
  collection: string;
  filesDiscovered: number;
  filesIndexed: number;
  filesSkippedUnchanged: number;
  filesFailed: number;
  filesPruned: number;
  chunksIndexed: number;
  durationMs: number;
  truncated: boolean;
  failures: Array<{ path: string; reason: string }>;
  roots: string[];
}

export class IndexingPipeline {
  private readonly writeLock = new Mutex();

  constructor(
    private readonly config: Config,
    private readonly db: VectorDatabase,
    private readonly embeddings: EmbeddingService,
  ) {}

  private chunkOptions(): ChunkOptions {
    return {
      targetTokens: this.config.chunkTokens,
      overlapTokens: this.config.chunkOverlap,
      minChars: this.config.minChunkChars,
    };
  }

  async resolveCollection(name: string): Promise<Collection> {
    const existing = this.db.prepare("SELECT id FROM collections WHERE name = ?").get(name);
    if (existing) return requireCollection(this.db, name);
    const spec = await this.embeddings.spec();
    return createCollection(this.db, name, spec, { sourceRoots: this.config.sourceRoots });
  }

  async indexPaths(input: IndexPathsInput): Promise<IndexSummary> {
    const startedAt = Date.now();
    const collection = await this.resolveCollection(input.collection);
    const opts = this.chunkOptions();

    const failures: Array<{ path: string; reason: string }> = [];
    const roots: string[] = [];
    const allFiles = new Map<string, string>();
    let truncated = false;

    for (const rawPath of input.paths) {
      const root = path.resolve(rawPath);
      roots.push(toPosix(root));
      const result = await discoverFiles({
        root,
        include: input.include,
        exclude: input.exclude,
        respectGitignore: input.respectGitignore,
        followSymlinks: input.followSymlinks,
        maxFiles: input.maxFiles,
        maxDepth: input.recursive ? input.maxDepth : 1,
      });
      if (result.truncated) truncated = true;
      for (const file of result.files) {
        const uri = toPosix(file.absolutePath);
        allFiles.set(uri, toPosix(path.relative(root, file.absolutePath)));
      }
    }

    if (allFiles.size === 0) {
      return {
        collection: collection.name,
        filesDiscovered: 0,
        filesIndexed: 0,
        filesSkippedUnchanged: 0,
        filesFailed: 0,
        filesPruned: 0,
        chunksIndexed: 0,
        durationMs: Date.now() - startedAt,
        truncated,
        failures,
        roots,
      };
    }

    let indexed = 0;
    let skipped = 0;
    let chunksIndexed = 0;
    let processed = 0;

    for (const [uri] of allFiles) {
      processed += 1;
      if (processed % 25 === 0) {
        input.progress?.(`indexing ${processed}/${allFiles.size}`);
      }

      try {
        const outcome = await this.indexOneFile(collection, uri, opts, input.force);
        if (outcome.status === "indexed") {
          indexed += 1;
          chunksIndexed += outcome.chunkCount;
        } else {
          skipped += 1;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failures.push({ path: uri, reason });
        log.debug("index failed", uri, reason);
      }
    }

    let pruned = 0;
    if (input.prune) {
      for (const root of roots) {
        const present = new Set<string>();
        for (const [uri, rel] of allFiles) {
          if (rel !== undefined) present.add(uri);
        }
        const stale = pruneMissingDocuments(this.db, collection, root, present);
        pruned += stale.length;
      }
    }

    return {
      collection: collection.name,
      filesDiscovered: allFiles.size,
      filesIndexed: indexed,
      filesSkippedUnchanged: skipped,
      filesFailed: failures.length,
      filesPruned: pruned,
      chunksIndexed,
      durationMs: Date.now() - startedAt,
      truncated,
      failures: failures.slice(0, 20),
      roots,
    };
  }

  private async indexOneFile(
    collection: Collection,
    uri: string,
    opts: ChunkOptions,
    force: boolean,
  ): Promise<{ status: "indexed"; chunkCount: number } | { status: "skipped" }> {
    const read = await readFileContent(uri, this.config.maxFileBytes);
    if (!read) return { status: "skipped" };

    const contentHash = sha256(read.text);
    const lang = languageForFile(uri);
    const title = lang.name === "markdown" ? summarizeMarkdown(read.text) : read.title;
    const language = guessLanguage(read.text);
    const stat = await fs.stat(uri).catch(() => null);

    if (!force) {
      const existing = findDocument(this.db, collection.id, uri);
      if (existing && existing.content_hash === contentHash) {
        return { status: "skipped" };
      }
    }

    const chunks = chunkDocument(read.text, { uri, title, options: opts });
    if (chunks.length === 0) return { status: "skipped" };

    const vectors = await this.embeddings.embedPassages(
      chunks.map((c) => c.embedText),
      collection.dim,
      chunks.map((c) => chunkHash(c.embedText)),
    );

    const result = await this.writeLock.runExclusive(() =>
      indexDocument(
        this.db,
        collection,
        {
          collectionId: collection.id,
          uri,
          title,
          language,
          kind: "file",
          mtime: stat?.mtimeMs ?? null,
          size: read.bytes,
          contentHash,
        },
        chunks.map((c) => ({
          text: c.text,
          embedText: c.embedText,
          tokens: c.tokens,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
        vectors,
      ),
    );

    return { status: "indexed", chunkCount: result.chunkCount };
  }

  async indexText(input: {
    text: string;
    uri: string;
    collection: string;
    title?: string | null;
    kind?: string;
    meta?: Record<string, unknown> | null;
    replace?: boolean;
  }): Promise<{ collection: string; uri: string; chunks: number; documentId: number }> {
    const collection = await this.resolveCollection(input.collection);
    const opts = this.chunkOptions();
    const uri = toPosix(path.resolve(input.uri));

    if (input.replace !== false) {
      await this.writeLock.runExclusive(() => deleteDocuments(this.db, collection, { uris: [uri] }));
    }

    const chunks = chunkDocument(input.text, {
      uri,
      title: input.title ?? null,
      options: opts,
    });

    if (chunks.length === 0) {
      throw new McpToolError("empty_text", `Text for "${uri}" produced no indexable chunks (too short).`);
    }

    const vectors = await this.embeddings.embedPassages(
      chunks.map((c) => c.embedText),
      collection.dim,
      chunks.map((c) => chunkHash(c.embedText)),
    );

    const result = await this.writeLock.runExclusive(() =>
      indexDocument(
        this.db,
        collection,
        {
          collectionId: collection.id,
          uri,
          title: input.title ?? null,
          language: guessLanguage(input.text),
          kind: input.kind ?? "text",
          mtime: null,
          size: Buffer.byteLength(input.text, "utf8"),
          contentHash: sha256(input.text),
          meta: input.meta ?? null,
        },
        chunks.map((c) => ({
          text: c.text,
          embedText: c.embedText,
          tokens: c.tokens,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
        vectors,
      ),
    );

    return {
      collection: collection.name,
      uri,
      chunks: result.chunkCount,
      documentId: result.documentId,
    };
  }
}