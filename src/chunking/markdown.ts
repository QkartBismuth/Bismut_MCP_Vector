import { estimateTokens, truncateChars } from "../util/text.js";
import { tailOfTokens } from "./prose.js";
import type { ChunkOptions, RawChunk } from "./types.js";

interface Section {
  heading: string;
  breadcrumb: string;
  startLine: number;
  endLine: number;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

export function splitMarkdown(text: string, opts: ChunkOptions): RawChunk[] {
  const lines = text.split("\n");
  const sections: Section[] = [];

  let current: Section | null = null;
  let fenceDepth = 0;
  let inFence = false;
  let fenceMarker = "";

  const headings: string[] = [];

  const startSection = (heading: string, level: number, line: number): Section => {
    headings.length = Math.min(headings.length, level - 1);
    headings[level - 1] = heading;
    return {
      heading,
      breadcrumb: headings.filter((h) => h && h.length > 0).join(" > "),
      startLine: line,
      endLine: lines.length,
      body: "",
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fenceMatch = FENCE.exec(line);

    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = (fenceMatch[1] ?? "").trim();
        fenceDepth = 0;
      } else if ((fenceMatch[1] ?? "").trim().startsWith(fenceMarker)) {
        fenceDepth += 1;
        if (fenceDepth > 0) inFence = false;
      }
      if (current) current.body += `${line}\n`;
      continue;
    }

    const headingMatch = !inFence ? HEADING.exec(line) : null;
    if (headingMatch) {
      if (current) {
        current.endLine = i;
        current.body = current.body.replace(/\n+$/, "");
        if (current.body.trim().length > 0 || current.heading.length > 0) sections.push(current);
      }
      const level = (headingMatch[1] ?? "#").length;
      current = startSection((headingMatch[2] ?? "").trim(), level, i + 1);
      continue;
    }

    if (current) {
      current.body += `${line}\n`;
    }
  }

  if (current) {
    current.endLine = lines.length;
    current.body = current.body.replace(/\n+$/, "");
    if (current.body.trim().length > 0 || current.heading.length > 0) sections.push(current);
  }

  if (sections.length === 0) {
    return [{ text: text.trim(), startLine: 1, endLine: lines.length, header: "" }].filter((c) =>
      c.text.length >= opts.minChars,
    );
  }

  const out: RawChunk[] = [];

  for (const section of sections) {
    const header = section.breadcrumb ? `${section.breadcrumb}\n\n` : "";
    const body = section.body.trim();

    if (body.length === 0) {
      if (section.heading) {
        out.push({
          text: `${section.breadcrumb}`.trim(),
          startLine: section.startLine,
          endLine: section.endLine,
          header: "",
        });
      }
      continue;
    }

    if (estimateTokens(header + body) <= opts.targetTokens) {
      if ((header + body).trim().length >= opts.minChars) {
        out.push({
          text: `${header}${body}`,
          startLine: section.startLine,
          endLine: section.endLine,
          header: "",
        });
      }
      continue;
    }

    const pieces = splitMarkdownBody(body, opts);
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] as { text: string; startLine: number; endLine: number };
      let body_ = piece.text;
      if (i > 0 && opts.overlapTokens > 0) {
        const tail = tailOfTokens(pieces[i - 1]?.text ?? "", opts.overlapTokens);
        if (tail) body_ = `${tail}\n\n${body_}`;
      }
      const full = `${header}${body_}`;
      if (full.trim().length >= opts.minChars) {
        out.push({
          text: full,
          startLine: section.startLine + piece.startLine,
          endLine: section.startLine + piece.endLine,
          header: "",
        });
      }
    }
  }

  return out.filter((c) => c.text.trim().length > 0);
}

function splitMarkdownBody(
  body: string,
  opts: ChunkOptions,
): Array<{ text: string; startLine: number; endLine: number }> {
  const lines = body.split("\n");
  const blocks: Array<{ text: string; start: number; end: number }> = [];
  let buffer: string[] = [];
  let start = 0;
  let inFence = false;
  let fenceMarker = "";

  const flush = (end: number): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n").trim();
    if (joined.length > 0) blocks.push({ text: joined, start, end });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "").trim();
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker.startsWith(fenceMarker)) {
        inFence = false;
      }
    }
    if (buffer.length === 0) start = i;
    if (line.trim() === "" && !inFence) {
      flush(i);
      continue;
    }
    buffer.push(line);
  }
  flush(lines.length);

  const packed: Array<{ text: string; start: number; end: number }> = [];
  let current: { text: string; start: number; end: number } | null = null;

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);
    if (!current) {
      current = { ...block };
      continue;
    }
    if (estimateTokens(current.text) + blockTokens + 1 <= opts.targetTokens) {
      current = { text: `${current.text}\n\n${block.text}`, start: current.start, end: block.end };
    } else {
      if (blockTokens > opts.targetTokens) {
        packed.push(current);
        current = null;
        packed.push(...splitOversizedBlock(block, opts));
        continue;
      }
      packed.push(current);
      current = { ...block };
    }
  }
  if (current) packed.push(current);

  return packed.map((b, i) => ({
    text: b.text,
    startLine: b.start + 1,
    endLine: i === packed.length - 1 ? lines.length : b.end + 1,
  }));
}

function splitOversizedBlock(
  block: { text: string; start: number; end: number },
  opts: ChunkOptions,
): Array<{ text: string; start: number; end: number }> {
  const lines = block.text.split("\n");
  const pieces: Array<{ text: string; start: number; end: number }> = [];
  let buffer: string[] = [];
  let tokens = 0;
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const t = estimateTokens(line) || 1;
    if (tokens + t > opts.targetTokens && buffer.length > 0) {
      pieces.push({ text: buffer.join("\n"), start: start + block.start, end: i + block.start });
      const tail = tailOfTokens(buffer.join("\n"), opts.overlapTokens);
      buffer = tail ? tail.split("\n") : [];
      start = i - buffer.length;
      tokens = estimateTokens(buffer.join("\n"));
    }
    if (buffer.length === 0) start = i;
    buffer.push(line);
    tokens += t;
  }
  if (buffer.length > 0) {
    pieces.push({ text: buffer.join("\n"), start: start + block.start, end: lines.length + block.start });
  }
  return pieces;
}

export function markdownTitle(text: string): string | null {
  for (const line of text.split("\n", 40)) {
    const m = HEADING.exec(line);
    if (m) return (m[2] ?? "").trim();
  }
  return null;
}

export function summarizeMarkdown(text: string, maxChars = 200): string {
  const title = markdownTitle(text);
  if (title) return truncateChars(title, maxChars);
  return truncateChars(text.replace(/\s+/g, " ").trim(), maxChars);
}
