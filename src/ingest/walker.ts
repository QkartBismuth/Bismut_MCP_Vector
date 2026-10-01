import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { log } from "../logger.js";
import { SKIP_DIRECTORIES } from "./extensions.js";
import { GitIgnore, GlobSet } from "./glob.js";
import { toPosix } from "../util/text.js";

export interface WalkOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  respectGitignore: boolean;
  followSymlinks: boolean;
  maxFiles: number;
  maxDepth: number;
}

export interface DiscoveredFile {
  absolutePath: string;
  relPath: string;
}

export interface WalkResult {
  files: DiscoveredFile[];
  truncated: boolean;
  scannedDirs: number;
}

const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.bismut/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.lock",
];

export async function discoverFiles(opts: WalkOptions): Promise<WalkResult> {
  const root = path.resolve(opts.root);
  const includeSet = opts.include?.length ? new GlobSet(opts.include) : null;
  const excludeSet = new GlobSet([...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])]);
  const gitignore = new GitIgnore();

  if (opts.respectGitignore) {
    await loadGitignore(root, gitignore);
  }

  const files: DiscoveredFile[] = [];
  const visited = new Set<string>();
  let truncated = false;
  let scannedDirs = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > opts.maxDepth) return;

    const real = await safeRealpath(dir);
    if (real) {
      if (visited.has(real)) return;
      visited.add(real);
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.debug("readdir failed", dir, String(err));
      return;
    }
    scannedDirs += 1;

    const subdirs: string[] = [];

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, absolute));
      if (rel.startsWith("..")) continue;

      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        if (gitignore.ignores(rel, true)) continue;
        if (excludeSet.matches(rel) || excludeSet.matches(`${rel}/`)) continue;
        subdirs.push(absolute);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!opts.followSymlinks) continue;
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat) continue;
        if (stat.isDirectory()) {
          subdirs.push(absolute);
          continue;
        }
        if (!stat.isFile()) continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      if (excludeSet.matches(rel)) continue;
      if (gitignore.ignores(rel, false)) continue;
      if (includeSet && !includeSet.matches(rel)) continue;

      files.push({ absolutePath: absolute, relPath: rel });
      if (files.length >= opts.maxFiles) {
        truncated = true;
        return;
      }
    }

    subdirs.sort();
    for (const sub of subdirs) {
      await walk(sub, depth + 1);
      if (truncated) return;
    }
  };

  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat) {
    return { files, truncated, scannedDirs };
  }

  if (rootStat.isFile()) {
    const rel = toPosix(path.relative(root, root));
    const base = path.basename(root);
    const includeMatch =
      !includeSet || includeSet.matches(base) || includeSet.matches(`**/${base}`) || includeSet.matches(rel);
    if (includeMatch && !excludeSet.matches(rel)) {
      files.push({ absolutePath: root, relPath: rel.length > 0 ? rel : base });
    }
    return { files, truncated, scannedDirs };
  }

  await walk(root, 0);
  return { files, truncated, scannedDirs };
}

async function loadGitignore(root: string, gitignore: GitIgnore): Promise<void> {
  const seen = new Set<string>();
  let dir = root;
  for (let i = 0; i < 24; i++) {
    const candidate = path.join(dir, ".gitignore");
    if (!seen.has(candidate)) {
      seen.add(candidate);
      const content = await fs.readFile(candidate, "utf8").catch(() => null);
      if (content) gitignore.add(content);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

async function safeRealpath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}
