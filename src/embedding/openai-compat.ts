import { McpToolError } from "../logger.js";
import { chunkArray } from "../util/async.js";
import type { Config } from "../config.js";
import { applyPrefix, l2Normalize, type EmbeddingProvider, type EmbeddingRole } from "./provider.js";

interface EmbeddingApiResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
  error?: { message?: string };
}

const DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
};

export class OpenAiCompatEmbeddingProvider implements EmbeddingProvider {
  readonly kind = "openai";
  readonly model: string;
  readonly dtype = "remote";
  readonly normalize = true;
  private observedDim = 0;

  constructor(private readonly config: Config) {
    this.model = config.model;
  }

  get dim(): number {
    if (this.observedDim > 0) return this.observedDim;
    const guessed = DIMENSIONS[this.model];
    if (guessed) return guessed;
    throw new McpToolError(
      "embedding_dim_unknown",
      `Unknown embedding dimension for model "${this.model}". Index one document first to detect it automatically.`,
    );
  }

  describe() {
    return {
      provider: this.kind,
      model: this.model,
      dtype: this.dtype,
      dim: this.dim,
      normalize: this.normalize,
    };
  }

  private endpoint(): string {
    const base = this.config.apiBase ?? "https://api.openai.com/v1";
    return `${base.replace(/\/+$/, "")}/embeddings`;
  }

  private headers(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new McpToolError("missing_api_key", "BISMUT_API_KEY is required for the openai embedding provider.");
    }
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  async probe(text = "dimension probe"): Promise<number> {
    const [vector] = await this.embed([text], "passage");
    return (vector as Float32Array).length;
  }

  async embed(texts: string[], role: EmbeddingRole): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixes = { query: "", passage: "" };
    const results: Float32Array[] = [];

    for (const batch of chunkArray(texts, Math.min(this.config.batchSize, 64))) {
      const body = {
        model: this.model,
        input: batch.map((t) => applyPrefix(t, role, prefixes)),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response: Response;
      try {
        response = await fetch(this.endpoint(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw new McpToolError(
          "embedding_request_failed",
          `Embedding request to ${this.endpoint()} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new McpToolError(
          "embedding_request_failed",
          `Embedding API returned ${response.status}: ${bodyText.slice(0, 400)}`,
        );
      }

      const payload = (await response.json()) as EmbeddingApiResponse;
      if (payload.error?.message) {
        throw new McpToolError("embedding_request_failed", payload.error.message);
      }
      const data = payload.data;
      if (!data || data.length === 0) {
        throw new McpToolError("embedding_failed", "Embedding API returned no vectors.");
      }
      const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const item of ordered) {
        if (!item.embedding) throw new McpToolError("embedding_failed", "Embedding API returned an empty vector.");
        const vector = new Float32Array(item.embedding);
        this.observedDim = vector.length;
        results.push(l2Normalize(vector));
      }
    }

    return results;
  }

  async dispose(): Promise<void> {}
}
