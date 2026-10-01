export type LanguageStyle = "brace" | "indent" | "markup";

export interface LanguageInfo {
  name: string;
  style: LanguageStyle;
  lineComment: string;
}

export const EXTENSION_MAP: Record<string, LanguageInfo> = {
  ts: { name: "typescript", style: "brace", lineComment: "//" },
  tsx: { name: "typescript", style: "brace", lineComment: "//" },
  mts: { name: "typescript", style: "brace", lineComment: "//" },
  cts: { name: "typescript", style: "brace", lineComment: "//" },
  js: { name: "javascript", style: "brace", lineComment: "//" },
  jsx: { name: "javascript", style: "brace", lineComment: "//" },
  mjs: { name: "javascript", style: "brace", lineComment: "//" },
  cjs: { name: "javascript", style: "brace", lineComment: "//" },
  py: { name: "python", style: "indent", lineComment: "#" },
  pyi: { name: "python", style: "indent", lineComment: "#" },
  go: { name: "go", style: "brace", lineComment: "//" },
  rs: { name: "rust", style: "brace", lineComment: "//" },
  java: { name: "java", style: "brace", lineComment: "//" },
  kt: { name: "kotlin", style: "brace", lineComment: "//" },
  kts: { name: "kotlin", style: "brace", lineComment: "//" },
  scala: { name: "scala", style: "brace", lineComment: "//" },
  swift: { name: "swift", style: "brace", lineComment: "//" },
  cs: { name: "csharp", style: "brace", lineComment: "//" },
  c: { name: "c", style: "brace", lineComment: "//" },
  h: { name: "c", style: "brace", lineComment: "//" },
  cpp: { name: "cpp", style: "brace", lineComment: "//" },
  cc: { name: "cpp", style: "brace", lineComment: "//" },
  hpp: { name: "cpp", style: "brace", lineComment: "//" },
  m: { name: "objc", style: "brace", lineComment: "//" },
  mm: { name: "objc", style: "brace", lineComment: "//" },
  php: { name: "php", style: "brace", lineComment: "//" },
  rb: { name: "ruby", style: "indent", lineComment: "#" },
  ex: { name: "elixir", style: "indent", lineComment: "#" },
  exs: { name: "elixir", style: "indent", lineComment: "#" },
  erl: { name: "erlang", style: "indent", lineComment: "%" },
  hs: { name: "haskell", style: "indent", lineComment: "--" },
  lua: { name: "lua", style: "brace", lineComment: "--" },
  dart: { name: "dart", style: "brace", lineComment: "//" },
  zig: { name: "zig", style: "brace", lineComment: "//" },
  proto: { name: "protobuf", style: "brace", lineComment: "//" },
  graphql: { name: "graphql", style: "brace", lineComment: "#" },
  gql: { name: "graphql", style: "brace", lineComment: "#" },
  css: { name: "css", style: "brace", lineComment: "//" },
  scss: { name: "scss", style: "brace", lineComment: "//" },
  less: { name: "less", style: "brace", lineComment: "//" },
  vue: { name: "vue", style: "brace", lineComment: "//" },
  svelte: { name: "svelte", style: "brace", lineComment: "//" },
  sh: { name: "shell", style: "brace", lineComment: "#" },
  bash: { name: "shell", style: "brace", lineComment: "#" },
  zsh: { name: "shell", style: "brace", lineComment: "#" },
  sql: { name: "sql", style: "brace", lineComment: "--" },
  json: { name: "json", style: "markup", lineComment: "//" },
  jsonc: { name: "json", style: "markup", lineComment: "//" },
  yaml: { name: "yaml", style: "indent", lineComment: "#" },
  yml: { name: "yaml", style: "indent", lineComment: "#" },
  toml: { name: "toml", style: "markup", lineComment: "#" },
  ini: { name: "ini", style: "markup", lineComment: ";" },
  tf: { name: "terraform", style: "brace", lineComment: "#" },
  hcl: { name: "terraform", style: "brace", lineComment: "#" },
  dockerfile: { name: "dockerfile", style: "markup", lineComment: "#" },
  makefile: { name: "make", style: "indent", lineComment: "#" },
  mk: { name: "make", style: "indent", lineComment: "#" },
};

export const FILENAME_MAP: Record<string, LanguageInfo> = {
  dockerfile: { name: "dockerfile", style: "markup", lineComment: "#" },
  makefile: { name: "make", style: "indent", lineComment: "#" },
  rakefile: { name: "ruby", style: "indent", lineComment: "#" },
  gemfile: { name: "ruby", style: "indent", lineComment: "#" },
  ".gitignore": { name: "gitignore", style: "markup", lineComment: "#" },
  ".env": { name: "dotenv", style: "markup", lineComment: "#" },
};

const MARKDOWN: LanguageInfo = { name: "markdown", style: "markup", lineComment: "//" };
const PLAINTEXT: LanguageInfo = { name: "plaintext", style: "markup", lineComment: "//" };

export function languageForFile(filePath: string): LanguageInfo {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  if (FILENAME_MAP[base.toLowerCase()]) return FILENAME_MAP[base.toLowerCase()] as LanguageInfo;
  if (base.toLowerCase().startsWith("dockerfile")) return FILENAME_MAP["dockerfile"] as LanguageInfo;
  if (base.toLowerCase().startsWith("makefile")) return FILENAME_MAP["makefile"] as LanguageInfo;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return PLAINTEXT;
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === "md" || ext === "mdx" || ext === "markdown") return MARKDOWN;
  return EXTENSION_MAP[ext] ?? PLAINTEXT;
}
