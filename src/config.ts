import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";
export type EmbeddingProviderKind = "local" | "openai";
export type Device = "cpu" | "gpu" | "auto";

export interface Config {
  dbPath: string;
  cacheDir: string;
  defaultCollection: string;
  provider: EmbeddingProviderKind;
  model: string;
  dtype: string;
  device: Device;
  batchSize: number;
  maxFileBytes: number;
  chunkTokens: number;
  chunkOverlap: number;
  minChunkChars: number;
  maxCollectionsPerQuery: number;
  apiKey?: string;
  apiBase?: string;
  timeoutMs: number;
  logLevel: LogLevel;
  sourceRoots: string[];
}

export const DEFAULT_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_DTYPE = "q8";

const DEFAULTS: Omit<Config, "dbPath" | "cacheDir"> = {
  defaultCollection: "default",
  provider: "local",
  model: DEFAULT_MODEL,
  dtype: DEFAULT_DTYPE,
  device: "cpu",
  batchSize: 16,
  maxFileBytes: 1_048_576,
  chunkTokens: 320,
  chunkOverlap: 60,
  minChunkChars: 24,
  maxCollectionsPerQuery: 4096,
  timeoutMs: 120_000,
  logLevel: "info",
  sourceRoots: [],
};

function envStr(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = envStr(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}

function loadConfigFile(): Record<string, unknown> {
  const explicit = envStr("BISMUT_CONFIG");
  const candidate = explicit ? resolveHome(explicit) : path.join(process.cwd(), ".bismutrc.json");
  try {
    if (!fs.existsSync(candidate)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    process.stderr.write(`[bismut:warn] failed to read config ${candidate}: ${String(err)}\n`);
  }
  return {};
}

function pickString(cfg: Record<string, unknown>, key: string, fallback: string): string {
  const v = cfg[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : fallback;
}

function pickNumber(cfg: Record<string, unknown>, key: string, fallback: number): number {
  const v = cfg[key];
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

export function loadConfig(): Config {
  const cfg = loadConfigFile();

  const rawDb = envStr("BISMUT_DB_PATH") ?? pickString(cfg, "dbPath", path.join(".bismut", "vectors.db"));
  const dbPath = path.resolve(resolveHome(rawDb));

  const cacheDirEnv = envStr("BISMUT_CACHE_DIR") ?? pickString(cfg, "cacheDir", "");
  const cacheDir = cacheDirEnv
    ? path.resolve(resolveHome(cacheDirEnv))
    : path.join(path.dirname(dbPath), "cache");

  const providerEnv = envStr("BISMUT_EMBED_PROVIDER")?.toLowerCase();
  const provider: EmbeddingProviderKind =
    providerEnv === "openai" || providerEnv === "remote"
      ? "openai"
      : providerEnv === "local"
        ? "local"
        : (pickString(cfg, "provider", DEFAULTS.provider) as EmbeddingProviderKind) === "openai"
          ? "openai"
          : "local";

  const deviceEnv = envStr("BISMUT_EMBED_DEVICE")?.toLowerCase();
  const device: Device =
    deviceEnv === "cpu" || deviceEnv === "gpu" || deviceEnv === "auto"
      ? deviceEnv
      : (pickString(cfg, "device", DEFAULTS.device) as Device);

  const rootsEnv = envStr("BISMUT_SOURCE_ROOTS");
  const rootsRaw = rootsEnv ? rootsEnv.split(path.delimiter) : cfg.sourceRoots;
  const sourceRoots = Array.isArray(rootsRaw)
    ? rootsRaw.filter((r): r is string => typeof r === "string").map((r) => path.resolve(resolveHome(r)))
    : DEFAULTS.sourceRoots;

  const apiKey = envStr("BISMUT_API_KEY") ?? pickString(cfg, "apiKey", "");
  const apiBase = envStr("BISMUT_API_BASE") ?? pickString(cfg, "apiBase", "");
  const logLevelEnv = envStr("BISMUT_LOG_LEVEL")?.toLowerCase();

  const config: Config = {
    dbPath,
    cacheDir,
    defaultCollection: envStr("BISMUT_COLLECTION") ?? pickString(cfg, "defaultCollection", DEFAULTS.defaultCollection),
    provider,
    model: envStr("BISMUT_EMBED_MODEL") ?? pickString(cfg, "model", DEFAULTS.model),
    dtype: envStr("BISMUT_EMBED_DTYPE") ?? pickString(cfg, "dtype", DEFAULTS.dtype),
    device,
    batchSize: envInt("BISMUT_BATCH_SIZE", pickNumber(cfg, "batchSize", DEFAULTS.batchSize)),
    maxFileBytes: envInt("BISMUT_MAX_FILE_BYTES", pickNumber(cfg, "maxFileBytes", DEFAULTS.maxFileBytes)),
    chunkTokens: envInt("BISMUT_CHUNK_TOKENS", pickNumber(cfg, "chunkTokens", DEFAULTS.chunkTokens)),
    chunkOverlap: envInt("BISMUT_CHUNK_OVERLAP", pickNumber(cfg, "chunkOverlap", DEFAULTS.chunkOverlap)),
    minChunkChars: envInt("BISMUT_MIN_CHUNK_CHARS", pickNumber(cfg, "minChunkChars", DEFAULTS.minChunkChars)),
    maxCollectionsPerQuery: envInt(
      "BISMUT_MAX_CONTEXT_CHUNKS",
      pickNumber(cfg, "maxContextChunks", DEFAULTS.maxCollectionsPerQuery),
    ),
    timeoutMs: envInt("BISMUT_TIMEOUT_MS", pickNumber(cfg, "timeoutMs", DEFAULTS.timeoutMs)),
    logLevel: (logLevelEnv as LogLevel) ?? pickString(cfg, "logLevel", DEFAULTS.logLevel) as LogLevel,
    sourceRoots,
  };

  if (config.provider === "openai") {
    if (!apiKey) {
      throw new Error(
        "BISMUT_EMBED_PROVIDER=openai requires BISMUT_API_KEY (or apiKey in .bismutrc.json).",
      );
    }
    config.apiKey = apiKey;
    if (apiBase) config.apiBase = apiBase;
  }

  return config;
}
