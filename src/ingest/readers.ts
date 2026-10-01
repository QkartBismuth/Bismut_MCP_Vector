import fs from "node:fs/promises";
import path from "node:path";
import { log, McpToolError } from "../logger.js";
import { extOf, isPdfPath, isTextPath, looksBinary } from "./extensions.js";

export interface ReadResult {
  text: string;
  bytes: number;
  title: string | null;
  reader: string;
}

function baseName(filePath: string): string {
  return path.basename(filePath);
}

function titleFromBase(filePath: string): string {
  const base = baseName(filePath).replace(/\.[^.]+$/, "");
  return base.replace(/[-_]+/g, " ").trim();
}

async function readPdf(filePath: string, bytes: number): Promise<ReadResult> {
  let unpdf: { extractText: (buf: Uint8Array, opts?: unknown) => Promise<{ text: string }> };
  try {
    unpdf = (await import("unpdf")) as unknown as typeof unpdf;
  } catch {
    throw new McpToolError(
      "pdf_reader_missing",
      `Cannot read ${filePath}: PDF support requires the optional "unpdf" package. Install it with: npm install unpdf`,
    );
  }

  const buffer = new Uint8Array(await fs.readFile(filePath));
  const result = await unpdf.extractText(buffer, { mergePages: true });
  const text = (result.text ?? "").trim();
  if (text.length === 0) {
    log.debug("pdf produced no text (likely scanned)", filePath);
  }
  return { text, bytes, title: titleFromBase(filePath), reader: "pdf" };
}

export async function readFileContent(
  filePath: string,
  maxBytes: number,
): Promise<ReadResult | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    log.debug("stat failed", filePath, String(err));
    return null;
  }

  if (!stat.isFile()) return null;
  if (stat.size === 0) return null;
  if (stat.size > maxBytes) {
    log.debug("skipping oversized file", filePath, stat.size);
    return null;
  }

  if (isPdfPath(filePath)) {
    return readPdf(filePath, stat.size);
  }

  if (!isTextPath(filePath)) {
    log.debug("skipping non-text extension", filePath);
    return null;
  }

  const buffer = await fs.readFile(filePath);
  if (looksBinary(buffer)) {
    log.debug("skipping binary content", filePath);
    return null;
  }

  const text = decodeBuffer(buffer);
  if (text.trim().length === 0) return null;

  return { text, bytes: stat.size, title: titleFromBase(filePath), reader: extOf(filePath) };
}

function decodeBuffer(buffer: Buffer): string {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return swapUtf16(buffer.subarray(2)).toString("utf16le");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("windows-1251", { fatal: false }).decode(buffer);
  } catch {
    return utf8;
  }
}

function swapUtf16(buffer: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    out[i] = buffer[i + 1] as number;
    out[i + 1] = buffer[i] as number;
  }
  return out;
}
