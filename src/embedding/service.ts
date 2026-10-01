import { log } from "../logger.js";
import type { Config } from "../config.js";
import type { VectorDatabase } from "../db/database.js";
import { lookupCachedVector, storeVectorsInCache } from "../db/store.js";
import type { EmbeddingSpec } from "../db/collections.js";
import { sha256 } from "../util/text.js";
import { chunkArray } from "../util/async.js";
import type { EmbeddingProvider } from "./provider.js";

export class EmbeddingService {
  private readonly cacheEnabled: boolean;
  private specPromise: Promise<EmbeddingSpec> | null = null;

  constructor(
    private readonly config: Config,
    private readonly provider: EmbeddingProvider,
    private readonly db: VectorDatabase,
  ) {
    this.cacheEnabled = process.env.BISMUT_DISABLE_CACHE !== "1";
  }

  get providerKind(): string {
    return this.provider.kind;
  }

  describe() {
    return this.provider.describe();
  }

  async spec(): Promise<EmbeddingSpec> {
    const cached = this.specPromise;
    if (cached) return cached;

    const pending: Promise<EmbeddingSpec> = this.provider
      .probe()
      .then((dim) => {
        log.debug("embedding dim detected", dim);
        return {
          dim,
          model: this.provider.model,
          dtype: this.provider.dtype,
          provider: this.provider.kind,
          queryPrefix: "",
          passagePrefix: "",
          normalize: this.provider.normalize,
        } satisfies EmbeddingSpec;
      })
      .catch((err: unknown) => {
        if (this.specPromise === pending) this.specPromise = null;
        throw err;
      });

    this.specPromise = pending;
    return pending;
  }

  async embedQueries(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.provider.embed(texts, "query");
  }

  async embedPassages(texts: string[], expectedDim: number, hashes?: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const keys = hashes ?? texts.map((t) => sha256(t));
    const out = new Array<Float32Array>(texts.length);
    const pending: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const key = keys[i] as string;
      const cached = this.cacheEnabled ? lookupCachedVector(this.db, this.provider.model, key) : undefined;
      if (cached && cached.length === expectedDim) {
        out[i] = cached;
      } else {
        pending.push(i);
      }
    }

    for (const group of chunkArray(pending, Math.max(1, this.config.batchSize))) {
      const inputs = group.map((i) => texts[i] as string);
      const vectors = await this.provider.embed(inputs, "passage");
      for (let j = 0; j < group.length; j++) {
        const index = group[j] as number;
        const vector = vectors[j] as Float32Array;
        if (vector.length !== expectedDim) {
          throw new Error(
            `Embedding dimension mismatch for "${this.provider.model}": expected ${expectedDim}, got ${vector.length}.`,
          );
        }
        out[index] = vector;
      }
      if (this.cacheEnabled) {
        storeVectorsInCache(
          this.db,
          this.provider.model,
          group.map((i) => keys[i] as string),
          group.map((i) => out[i] as Float32Array),
        );
      }
    }

    return out;
  }

  async dispose(): Promise<void> {
    await this.provider.dispose();
  }
}
