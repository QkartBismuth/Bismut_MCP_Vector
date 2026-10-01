import { detectLanguage, estimateTokens, sha256, truncateChars } from "../util/text.js";
import { extractPreamble, splitCode } from "./code.js";
import { languageForFile, type LanguageInfo } from "./languages.js";
import { splitMarkdown } from "./markdown.js";
import { splitProse } from "./prose.js";
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions, type RawChunk } from "./types.js";

export interface ChunkDocument {
  text: string;
  embedText: string;
  tokens: number;
  startLine: number | null;
  endLine: number | null;
}

export interface ChunkInputContext {
  uri: string;
  title?: string | null;
  options?: Partial<ChunkOptions>;
}

export function chunkDocument(text: string, ctx: ChunkInputContext): ChunkDocument[] {
  const opts: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...ctx.options };
  const lang = languageForFile(ctx.uri);
  const header = buildFileHeader(ctx.uri, ctx.title ?? null, lang);

  let raw: RawChunk[];

  if (lang.name === "markdown") {
    raw = splitMarkdown(text, opts);
  } else if (lang.style === "brace" || lang.style === "indent") {
    const lines = text.split("\n");
    const preamble = truncateChars(extractPreamble(lines, lang), 700);
    raw = splitCode(text, lang, opts, preamble);
  } else {
    raw = splitProse(text, opts);
  }

  const out: ChunkDocument[] = [];
  for (const chunk of raw) {
    const body = chunk.text.trim();
    if (body.length < opts.minChars && chunk.text.trim().length > 0 && body.length === 0) continue;

    const embedParts: string[] = [header];
    if (chunk.header) embedParts.push(chunk.header);
    embedParts.push(body);

    const embedText = embedParts.filter((p) => p.length > 0).join("\n").slice(0, 8000);

    out.push({
      text: chunk.text,
      embedText,
      tokens: estimateTokens(embedText),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    });
  }

  return out;
}

export function buildFileHeader(uri: string, title: string | null, lang: LanguageInfo): string {
  const lines = [`file: ${uri}`];
  if (title) lines.push(`title: ${title}`);
  if (lang.name && lang.name !== "plaintext") lines.push(`lang: ${lang.name}`);
  return lines.join("\n");
}

export function chunkHash(embedText: string): string {
  return sha256(embedText);
}

export function guessLanguage(text: string): string {
  return detectLanguage(text.slice(0, 4000));
}
