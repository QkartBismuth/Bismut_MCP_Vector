export interface RawChunk {
  text: string;
  startLine: number | null;
  endLine: number | null;
  header: string;
}

export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 320,
  overlapTokens: 60,
  minChars: 24,
};
