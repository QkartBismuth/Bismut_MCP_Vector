import { McpToolError, log } from "../logger.js";
import { chunkArray } from "../util/async.js";
import type { Config } from "../config.js";
import { applyPrefix, l2Normalize, type EmbeddingProvider, type EmbeddingRole } from "./provider.js";

interface FeatureExtractionPipeline {
  (
    texts: string | string[],
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<{ dims: number[]; data: Float32Array }>;
  dispose?: () => Promise<void>;
}

export class LocalOnnxEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "local";
  readonly normalize: boolean;

  private pipeline: FeatureExtractionPipeline | null = null;
  private loading: Promise<void> | null = null;
  private observedDim = 0;
  private observedModel = "";
  private observedDtype = "";

  constructor(private readonly config: Config) {
    this.normalize = true;
  }

  get model(): string {
    return this.observedModel || this.config.model;
  }

  get dtype(): string {
    return this.observedDtype || this.config.dtype;
  }

  get dim(): number {
    if (this.observedDim === 0) {
      throw new McpToolError(
        "embedding_not_initialized",
        "Local embedding model is not initialized yet. Run any indexing or search operation first.",
      );
    }
    return this.observedDim;
  }

  describe() {
    return {
      provider: this.kind,
      model: this.model,
      dtype: this.dtype,
      dim: this.observedDim,
      loaded: this.pipeline !== null,
      device: this.config.device,
      normalize: this.normalize,
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const t0 = Date.now();
      const mod = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<FeatureExtractionPipeline>;
        env: { cacheDir?: string; backends?: Record<string, unknown> };
      };

      if (this.config.cacheDir) {
        mod.env.cacheDir = this.config.cacheDir;
      }

      log.info("loading embedding model", this.config.model, `dtype=${this.config.dtype}`);
      this.pipeline = await mod.pipeline("feature-extraction", this.config.model, {
        dtype: this.config.dtype,
        device: this.config.device === "auto" ? undefined : this.config.device,
      });
      this.observedModel = this.config.model;
      this.observedDtype = this.config.dtype;
      log.info("embedding model ready", `${Date.now() - t0}ms`, `device=${this.config.device}`);
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async probe(text = "dimension probe"): Promise<number> {
    await this.ensureLoaded();
    const [vector] = await this.run([text]);
    return (vector as Float32Array).length;
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    const pipeline = this.pipeline;
    if (!pipeline) throw new McpToolError("embedding_not_loaded", "Embedding pipeline is not loaded.");

    const output = await pipeline(texts, { pooling: "mean", normalize: this.normalize });
    const dims = output.dims;
    const dim = dims[dims.length - 1] ?? 0;
    if (dim <= 0) throw new McpToolError("embedding_failed", "Embedding model returned an empty vector.");

    const count = Math.floor(output.data.length / dim);
    if (count !== texts.length) {
      throw new McpToolError(
        "embedding_failed",
        `Embedding model returned ${count} vectors for ${texts.length} inputs.`,
      );
    }
    this.observedDim = dim;

    const vectors: Float32Array[] = new Array(count);
    for (let i = 0; i < count; i++) {
      vectors[i] = output.data.slice(i * dim, (i + 1) * dim) as Float32Array;
    }
    return vectors;
  }

  async embed(texts: string[], role: EmbeddingRole): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ensureLoaded();

    const prepared = texts.map((t) => applyPrefix(t, role, { query: "", passage: "" }));
    const results: Float32Array[] = [];

    for (const batch of chunkArray(prepared, this.config.batchSize)) {
      const vectors = await this.run(batch);
      for (const v of vectors) {
        results.push(this.normalize ? l2Normalize(v) : v);
      }
    }
    return results;
  }

  async dispose(): Promise<void> {
    if (this.pipeline?.dispose) {
      try {
        await this.pipeline.dispose();
      } catch (err) {
        log.debug("pipeline dispose failed", err);
      }
    }
    this.pipeline = null;
  }
}
