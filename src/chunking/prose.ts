import { estimateTokens } from "../util/text.js";
import type { ChunkOptions, RawChunk } from "./types.js";

interface Block {
  text: string;
  startLine: number;
  endLine: number;
}

export function splitProse(text: string, opts: ChunkOptions): RawChunk[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let startLine = 1;

  const flush = (endLine: number): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n").trim();
    if (joined.length > 0) blocks.push({ text: joined, startLine, endLine });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      flush(i);
      continue;
    }
    if (buffer.length === 0) startLine = i + 1;
    buffer.push(line);
  }
  flush(lines.length);

  if (blocks.length === 0) {
    const trimmed = text.trim();
    if (trimmed.length >= opts.minChars) {
      return [{ text: trimmed, startLine: 1, endLine: lines.length, header: "" }];
    }
    return [];
  }

  const packed: Block[] = [];
  let current: Block | null = null;

  for (const block of blocks) {
    if (!current) {
      current = { ...block };
      continue;
    }
    const mergedTokens = estimateTokens(current.text) + estimateTokens(block.text) + 1;
    if (mergedTokens <= opts.targetTokens) {
      current = {
        text: `${current.text}\n\n${block.text}`,
        startLine: current.startLine,
        endLine: block.endLine,
      };
    } else {
      packed.push(current);
      current = { ...block };
    }
  }
  if (current) packed.push(current);

  const out: RawChunk[] = [];
  for (let i = 0; i < packed.length; i++) {
    const block = packed[i] as Block;
    let chunkText = block.text;

    if (i < packed.length - 1 && opts.overlapTokens > 0) {
      const tail = tailOfTokens(block.text, opts.overlapTokens);
      if (tail && !chunkText.startsWith(tail)) {
        chunkText = `${tail}\n\n${chunkText}`;
      }
    }

    if (chunkText.trim().length < opts.minChars) continue;
    out.push({ text: chunkText, startLine: block.startLine, endLine: block.endLine, header: "" });
  }

  return out;
}

export function tailOfTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const paragraphs = text.split(/\n\n+/);
  const kept: string[] = [];
  let total = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i] as string;
    const t = estimateTokens(p);
    if (total + t > maxTokens && kept.length > 0) break;
    kept.unshift(p);
    total += t;
    if (total >= maxTokens) break;
  }
  return kept.join("\n\n").trim();
}

export function hardSplitText(text: string, opts: ChunkOptions): RawChunk[] {
  const lines = text.split("\n");
  const out: RawChunk[] = [];
  let buffer: string[] = [];
  let start = 1;
  let tokens = 0;

  const flush = (end: number): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n");
    if (joined.trim().length >= opts.minChars) {
      out.push({ text: joined, startLine: start, endLine: end, header: "" });
    }
    buffer = [];
    tokens = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineTokens = estimateTokens(line) || 1;
    if (tokens + lineTokens > opts.targetTokens && buffer.length > 0) {
      flush(i);
      start = i + 1;
    }
    if (buffer.length === 0) start = i + 1;
    buffer.push(line);
    tokens += lineTokens;
  }
  flush(lines.length);

  return out;
}
