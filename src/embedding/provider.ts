export type EmbeddingRole = "query" | "passage";

export interface EmbeddingRequest {
  texts: string[];
  role: EmbeddingRole;
  prefixes: { query: string; passage: string };
}

export interface EmbeddingProvider {
  readonly kind: string;
  readonly model: string;
  readonly dtype: string;
  readonly dim: number;
  readonly normalize: boolean;
  describe(): { provider: string; model: string; dtype: string; dim: number; normalize: boolean };
  probe(text?: string): Promise<number>;
  embed(texts: string[], role: EmbeddingRole): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const v = vector[i] as number;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    out[i] = (vector[i] as number) / norm;
  }
  return out;
}

export function applyPrefix(text: string, role: EmbeddingRole, prefixes: EmbeddingRequest["prefixes"]): string {
  const prefix = role === "query" ? prefixes.query : prefixes.passage;
  if (!prefix) return text;
  if (text.startsWith(prefix)) return text;
  return `${prefix}${text}`;
}
