export interface TextExtensionRule {
  ext: string;
  reader: "text" | "pdf" | "json-pretty";
}

export const TEXT_EXTENSIONS = new Set([
  "txt", "text", "log", "csv", "tsv",
  "md", "mdx", "markdown", "mdc",
  "rst", "adoc", "asciidoc", "org",
  "tex",
  "json", "json5", "jsonc", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "xml", "plist", "xhtml", "svg",
  "html", "htm", "vue", "svelte", "astro",
  "css", "scss", "sass", "less",
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift",
  "cs", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "m", "mm",
  "php", "pl", "pm", "lua", "dart", "zig", "ex", "exs", "erl", "hrl",
  "hs", "clj", "cljs", "groovy", "vue",
  "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "thrift", "avsc",
  "tf", "tfvars", "hcl", "dockerfile", "makefile", "mk", "cmake",
  "gradle", "bzl", "bazel", "nix",
  "patch", "diff", "srt", "vtt",
  "gltf", "obj", "wat", "wasm",
  "ipynb",
]);

export const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", ".bzr",
  "dist", "build", "out", "output", "target", "bin", "obj",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
  "coverage", ".nyc_output", "htmlcov",
  ".venv", "venv", "env", ".env.d", "virtualenv", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".gradle", ".m2", "vendor", "Pods",
  ".idea", ".vscode-test", ".terraform", ".dart_tool", ".stack-work",
  "bismut-cache", ".bismut",
]);

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff",
  "mp3", "mp4", "wav", "ogg", "flac", "aac", "m4a", "mov", "avi", "mkv", "webm",
  "zip", "tar", "gz", "bz2", "xz", "7z", "rar", "zst",
  "exe", "dll", "so", "dylib", "class", "jar", "wasm", "bin", "o", "a", "obj",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "epub", "mobi",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "mdb", "dat", "pickle", "pkl", "npy", "npz", "pt", "pth", "onnx", "safetensors",
  "lock",
]);

export function extOf(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.toLowerCase();
  return base.slice(dot + 1).toLowerCase();
}

export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extOf(filePath));
}

export function isTextPath(filePath: string): boolean {
  const base = (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile") || base.startsWith("makefile")) return true;
  if (base === ".gitignore" || base === ".dockerignore" || base === ".npmignore") return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "license" || base === "notice" || base === "authors" || base === "changelog") return true;
  return TEXT_EXTENSIONS.has(extOf(filePath));
}

export function isPdfPath(filePath: string): boolean {
  return extOf(filePath) === "pdf";
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}
