import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string): string {
  return sha256(input).slice(0, 16);
}

export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n");
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CYRILLIC = /\p{Script=Cyrillic}/u;

export function detectLanguage(sample: string): string {
  if (sample.length === 0) return "und";
  if (CJK.test(sample)) return "zh";
  const letters = sample.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return "und";
  let cyr = 0;
  for (const ch of letters) {
    if (CYRILLIC.test(ch)) cyr += 1;
  }
  const cyrRatio = cyr / letters.length;
  if (cyrRatio > 0.3) return "ru";
  if (sample.match(/\b(the|and|of|to|in|is|for|that|with)\b/gi)?.length ?? 0 > letters.length / 12) {
    return "en";
  }
  return "und";
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const cjkChars = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const punctuation = (text.match(/[.,;:!?()[\]{}"'`/\\|<>@#$%^&*+=~-]/g) ?? []).length;
  return Math.max(1, Math.ceil(words * 1.32 + cjkChars * 0.9 + punctuation * 0.3));
}

export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
  return (lastBreak > maxChars * 0.5 ? slice.slice(0, lastBreak + 1) : slice).trimEnd();
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function nowMs(): number {
  return Date.now();
}
