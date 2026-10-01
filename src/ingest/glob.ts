export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  const g = glob;

  while (i < g.length) {
    const ch = g[i] as string;
    const next = g[i + 1];

    if (ch === "*" && next === "*") {
      const beforeSlash = g[i + 2] === "/";
      if (beforeSlash) {
        re += "(?:.*/)?";
        i += 3;
        continue;
      }
      re += ".*";
      i += 2;
      continue;
    }

    if (ch === "*") {
      re += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }

    if (ch === "{") {
      const close = findClosingBrace(g, i);
      if (close > i) {
        const inner = g.slice(i + 1, close);
        const parts = splitAlternatives(inner);
        re += `(?:${parts.map((p) => globToRegExp(p).source.replace(/^\^|\$$/g, "")).join("|")})`;
        i = close + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = g.indexOf("]", i + 1);
      if (close > i) {
        let cls = g.slice(i + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls}]`;
        i = close + 1;
        continue;
      }
    }

    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  return new RegExp(`^${re}$`);
}

function findClosingBrace(g: string, start: number): number {
  let depth = 0;
  for (let i = start; i < g.length; i++) {
    if (g[i] === "{") depth += 1;
    else if (g[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

export class GlobSet {
  private readonly patterns: Array<{ re: RegExp; negate: boolean }>;

  constructor(globs: string[]) {
    this.patterns = globs.map((g) => {
      const negate = g.startsWith("!");
      const raw = negate ? g.slice(1) : g;
      const normalized = raw.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
      const anchored = normalized.includes("/");
      const withPrefix = normalized.startsWith("**/") ? normalized : anchored ? normalized : `**/${normalized}`;
      return { re: globToRegExp(withPrefix), negate };
    });
  }

  matches(relPath: string): boolean {
    if (this.patterns.length === 0) return false;
    let result = false;
    for (const p of this.patterns) {
      if (p.re.test(relPath)) result = !p.negate;
    }
    return result;
  }

  get size(): number {
    return this.patterns.length;
  }
}

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export class GitIgnore {
  private readonly rules: IgnoreRule[] = [];

  add(content: string): void {
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const negate = line.startsWith("!");
      const body = negate ? line.slice(1) : line;
      const dirOnly = body.endsWith("/");
      const cleaned = body.replace(/^\/+/, "").replace(/\/+$/, "");
      if (cleaned.length === 0) continue;

      const hasSlash = cleaned.includes("/");
      const base = hasSlash ? cleaned : `**/${cleaned}`;
      const expanded = base.startsWith("**/") ? base : `**/${base}`;
      try {
        this.rules.push({
          re: globToRegExp(`${expanded}/**`) ,
          negate,
          dirOnly,
        });
        this.rules.push({
          re: globToRegExp(expanded),
          negate,
          dirOnly,
        });
      } catch {
        continue;
      }
    }
  }

  get size(): number {
    return this.rules.length;
  }

  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(relPath)) ignored = !rule.negate;
    }
    return ignored;
  }
}
