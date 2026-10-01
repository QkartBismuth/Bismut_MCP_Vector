const LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LEVELS)[number];

let current: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  if (LEVELS.includes(level)) current = level;
}

function enabled(level: Exclude<LogLevel, "silent">): boolean {
  return LEVELS.indexOf(current) <= 0 || LEVELS.indexOf(level) <= LEVELS.indexOf(current);
}

function emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (!enabled(level)) return;
  const line = args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  process.stderr.write(`[bismut:${level}] ${line}\n`);
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
  trace: (...args: unknown[]) => emit("trace", args),
};

export class McpToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "McpToolError";
    this.code = code;
  }
}

export function isMcpToolError(err: unknown): err is McpToolError {
  return err instanceof McpToolError;
}

export function errorMessage(err: unknown): string {
  if (isMcpToolError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
