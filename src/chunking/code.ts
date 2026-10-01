import { estimateTokens } from "../util/text.js";
import { hardSplitText } from "./prose.js";
import type { LanguageInfo } from "./languages.js";
import type { ChunkOptions, RawChunk } from "./types.js";

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:declare\s+)?(?:type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\()/,
  /\b(?:public|private|protected|internal|static|final|abstract|override|open|sealed|partial|virtual|suspend|inline|export|const|async)\s+[A-Za-z_$][\w$<>\[\],.?]*\s+([A-Za-z_$][\w$]*)\s*\(/,
  /\bdef\s+([A-Za-z_][\w]*)/,
  /\bclass\s+([A-Za-z_][\w]*)/,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /\btype\s+([A-Za-z_][\w]*)/,
  /\b(?:struct|enum|trait|impl|mod|union)\s+([A-Za-z_][\w]*)/,
  /\b(?:module|def)\s+([A-Za-z_][\w!?]*)[\s:(]/,
  /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|FUNCTION|TRIGGER|INDEX|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([A-Za-z_][\w$]*)/i,
  /\b(?:resource|module|variable|output|provider|data)\s+"([^"]+)"/,
  /^\s*([A-Za-z_][\w-]*)\s*(?::[^;]*)?;?\s*$/,
];

function extractSymbol(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  for (const pattern of SYMBOL_PATTERNS) {
    const m = pattern.exec(trimmed);
    if (m) {
      const name = (m[2] ?? m[1] ?? "").trim();
      if (name.length > 0 && name.length < 120) return name;
    }
  }
  return null;
}

export interface CodeBlock {
  startLine: number;
  endLine: number;
  symbol: string | null;
  text: string;
}

export function extractPreamble(lines: string[], lang: LanguageInfo): string {
  const collected: string[] = [];
  let inBlockComment = false;
  let consecutive = 0;

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (collected.length === 0) continue;
      consecutive += 1;
      if (consecutive > 1) break;
      collected.push("");
      continue;
    }
    consecutive = 0;

    if (inBlockComment) {
      collected.push(line);
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }

    if (trimmed.startsWith("/*") || trimmed.startsWith("/**")) {
      collected.push(line);
      if (!trimmed.includes("*/", 2)) inBlockComment = true;
      continue;
    }

    if (trimmed.startsWith(lang.lineComment) || trimmed.startsWith("#!") || trimmed.startsWith("#[")) {
      collected.push(line);
      continue;
    }

    const isImport =
      /^(import|from|require|include|using|#include|namespace|package\b|\/\/\s*=|#\[)/.test(trimmed) ||
      /^(pub\s+)?use\s+[\w:]+/.test(trimmed) ||
      /^(export\s+)?(type\s+)?\{\s*[^}]*\}\s*from\s+/.test(trimmed);
    if (isImport) {
      collected.push(line);
      continue;
    }

    break;
  }

  const cleaned = collected.join("\n").replace(/\n{2,}/g, "\n").trim();
  return truncatePreamble(cleaned);
}

function truncatePreamble(text: string): string {
  const maxChars = 700;
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > maxChars) break;
    kept.push(line);
    size += line.length + 1;
  }
  return kept.join("\n").trim();
}

interface BraceState {
  depth: number;
  inString: '"' | "'" | "`" | null;
  inLineComment: boolean;
  inBlockComment: boolean;
  escaped: boolean;
}

function newBraceState(): BraceState {
  return {
    depth: 0,
    inString: null,
    inLineComment: false,
    inBlockComment: false,
    escaped: false,
  };
}

function scanLine(state: BraceState, line: string, lineComments: string[]): void {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    const next = line[i + 1];

    if (state.inLineComment) {
      if (ch === "\n") state.inLineComment = false;
      continue;
    }

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (ch === "\\") {
        state.escaped = true;
        continue;
      }
      if (ch === state.inString) {
        state.inString = null;
        continue;
      }
      if (state.inString === "`" && ch === "$" && next === "{") {
        state.depth += 1;
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      if (lineComments.includes("//")) {
        state.inLineComment = true;
        i = line.length;
        continue;
      }
    }
    if (ch === "#" && lineComments.includes("#")) {
      state.inLineComment = true;
      i = line.length;
      continue;
    }
    if (ch === "-" && next === "-" && lineComments.includes("--")) {
      state.inLineComment = true;
      i = line.length;
      continue;
    }
    if (ch === "%" && lineComments.includes("%")) {
      state.inLineComment = true;
      i = line.length;
      continue;
    }

    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      state.inString = ch;
      state.escaped = false;
      continue;
    }

    if (ch === "{") state.depth += 1;
    else if (ch === "}") {
      state.depth -= 1;
      if (state.depth < 0) state.depth = 0;
    }
  }
}

function lineCommentsFor(lang: LanguageInfo): string[] {
  const comments = [lang.lineComment];
  if (lang.style === "brace") comments.push("//");
  return [...new Set(comments)];
}

export function collectBraceBlocks(lines: string[], lang: LanguageInfo): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const comments = lineCommentsFor(lang);
  const state = newBraceState();

  let singles: number[] = [];

  const flushSingles = (): void => {
    if (singles.length === 0) return;
    while (singles.length > 0 && (lines[singles[singles.length - 1] as number] ?? "").trim() === "") {
      singles.pop();
    }
    if (singles.length === 0) return;
    const start = singles[0] as number;
    const end = singles[singles.length - 1] as number;
    const text = lines.slice(start, end + 1).join("\n");
    if (text.trim().length > 0) {
      const symbols = singles
        .map((idx) => extractSymbol(lines[idx] as string))
        .filter((s): s is string => s !== null);
      const uniform = symbols.length === singles.length ? (symbols[0] ?? null) : null;
      blocks.push({
        startLine: start + 1,
        endLine: end + 1,
        symbol: uniform,
        text,
      });
    }
    singles = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const before = state.depth;
    scanLine(state, line, comments);
    const after = state.depth;

    if (before === 0 && after === 0) {
      singles.push(i);
      continue;
    }

    if (before === 0 && after > 0) {
      while (singles.length > 0 && continuesIntoBlock(lines[singles[singles.length - 1] as number] as string)) {
        singles.pop();
      }
      flushSingles();

      let j = i + 1;
      while (j < lines.length) {
        const depthBefore = state.depth;
        scanLine(state, lines[j] as string, comments);
        if (depthBefore > 0 && state.depth === 0) break;
        j += 1;
      }
      const end = Math.min(j, lines.length - 1);
      const lookahead = lines.slice(i, Math.min(i + 3, lines.length)).join("\n");
      const symbol = extractSymbol(line) ?? extractSymbol(lookahead);
      const text = lines.slice(i, end + 1).join("\n");
      if (text.trim().length > 0) {
        blocks.push({ startLine: i + 1, endLine: end + 1, symbol, text });
      }
      i = end;
      continue;
    }

    if (before > 0) {
      singles.push(i);
    }
  }

  flushSingles();

  return blocks.filter((b) => b.text.trim().length > 0);
}

function continuesIntoBlock(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith(";") || trimmed.endsWith("}") || trimmed.endsWith("{")) return false;
  if (/^(import|from|use|require|include|package|#include|using|mod|pub\s+use|export\s+\*)/.test(trimmed)) return false;
  return true;
}

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function collectIndentBlocks(lines: string[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let blockStart = -1;
  let blockSymbol: string | null = null;
  let baseIndent = 0;

  const flush = (endIndex: number): void => {
    if (blockStart < 0) return;
    const slice = lines.slice(blockStart, endIndex + 1);
    const text = slice.join("\n");
    if (text.trim().length > 0) {
      blocks.push({
        startLine: blockStart + 1,
        endLine: endIndex + 1,
        symbol: blockSymbol,
        text,
      });
    }
    blockStart = -1;
    blockSymbol = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const isDecorator = trimmed.startsWith("@");
    const symbol = isDecorator ? null : extractSymbol(line);
    const defLike = symbol !== null && /^(def |class |module |func |fn |defmacro |task |describe |it |test)/.test(trimmed);
    const alsoDef = symbol !== null && !defLike && indentOf(line) === 0;

    if (indentOf(line) === 0 && (defLike || alsoDef)) {
      if (blockStart >= 0) flush(i - 1);
      blockStart = i;
      blockSymbol = symbol;
      baseIndent = 0;
      continue;
    }

    if (blockStart >= 0 && !isDecorator) {
      const ind = indentOf(line);
      if (ind <= baseIndent && ind !== 0) {
        flush(i - 1);
      }
    }
  }

  if (blockStart >= 0) flush(lines.length - 1);
  return blocks;
}

export function splitCode(text: string, lang: LanguageInfo, opts: ChunkOptions, preamble: string): RawChunk[] {
  const lines = text.split("\n");
  const blocks =
    lang.style === "indent" ? collectIndentBlocks(lines) : collectBraceBlocks(lines, lang);

  if (blocks.length === 0) {
    return hardSplitText(text, opts).map((c) => ({ ...c, header: preamble ? `file: ${preamble}` : "" }));
  }

  const headerFor = (block: CodeBlock): string => {
    const parts: string[] = [];
    if (block.symbol) parts.push(block.symbol);
    if (preamble) parts.push(preamble);
    return parts.length > 0 ? parts.join("\n") : "";
  };

  const out: RawChunk[] = [];
  let pending: CodeBlock[] = [];

  const emitPending = (): void => {
    if (pending.length === 0) return;
    const start = pending[0] as CodeBlock;
    const end = pending[pending.length - 1] as CodeBlock;
    const body = pending.map((b) => b.text).join("\n");
    const header = headerFor(start);
    const full = header ? `${header}\n\n${body}` : body;
    if (full.trim().length >= opts.minChars) {
      out.push({ text: full, startLine: start.startLine, endLine: end.endLine, header });
    }
    pending = [];
  };

  for (const block of blocks) {
    const tokens = estimateTokens(block.text);

    if (tokens > opts.targetTokens * 1.6) {
      emitPending();
      const header = headerFor(block);
      for (const piece of hardSplitText(block.text, { ...opts, targetTokens: opts.targetTokens })) {
        const full = header ? `${header}\n\n${piece.text}` : piece.text;
        if (full.trim().length >= opts.minChars) {
          out.push({
            text: full,
            startLine: block.startLine + (piece.startLine ?? 1) - 1,
            endLine: block.startLine + (piece.endLine ?? 1) - 1,
            header,
          });
        }
      }
      continue;
    }

    const first = pending[0] as CodeBlock | undefined;
    if (!first) {
      pending.push(block);
      continue;
    }

    const sameSymbol = (first.symbol ?? null) === (block.symbol ?? null);
    const pendingTokens = pending.reduce((s, b) => s + estimateTokens(b.text), 0);

    if (sameSymbol && pendingTokens + tokens <= opts.targetTokens) {
      pending.push(block);
      continue;
    }

    emitPending();
    pending.push(block);
  }
  emitPending();

  return out;
}
