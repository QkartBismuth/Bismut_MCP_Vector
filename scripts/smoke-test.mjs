import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const serverEntry = path.join(repoRoot, "dist", "index.js");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function parse(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

async function main() {
  const dbDir = path.join(repoRoot, ".bismut-test");
  await fs.rm(dbDir, { recursive: true, force: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      BISMUT_DB_PATH: path.join(dbDir, "vectors.db"),
      BISMUT_COLLECTION: "selftest",
      BISMUT_LOG_LEVEL: "warn",
    },
    stderr: "inherit",
  });

  const client = new Client({ name: "bismut-selftest", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("\n== protocol handshake ==");
  const serverInfo = client.getServerVersion();
  const manifestVersion = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")).version;
  console.log("  server:", JSON.stringify(serverInfo));
  check("server name is bismut-vector-mcp", serverInfo?.name === "bismut-vector-mcp", String(serverInfo?.name));
  check("advertised version matches package.json", serverInfo?.version === manifestVersion,
    `${serverInfo?.version} vs ${manifestVersion}`);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  console.log("  tools:", toolNames.join(", "));
  check("all expected tools registered", 
    ["index_paths","index_text","search","get_context","get_chunk","list_sources","list_collections","delete_sources","drop_collection","stats"].every(n => toolNames.includes(n)),
    toolNames.join(","));

  console.log("\n== stats ==");
  const stats = parse(await client.callTool({ name: "stats", arguments: {} }));
  check("stats ok", stats.ok === true);
  check("embedding model reported", stats.embedding?.model?.includes("paraphrase"), JSON.stringify(stats.embedding));
  check("db path uses test dir", String(stats.database_path).includes(".bismut-test"), stats.database_path);

  console.log("\n== index_paths (this repo's src) ==");
  const indexed = parse(await client.callTool({
    name: "index_paths",
    arguments: { paths: [path.join(repoRoot, "src")], include: ["**/*.ts"], collection: "selftest" },
  }));
  console.log("  summary:", JSON.stringify({
    discovered: indexed.filesDiscovered, indexed: indexed.filesIndexed,
    skipped: indexed.filesSkippedUnchanged, chunks: indexed.chunksIndexed,
    failed: indexed.filesFailed, ms: indexed.durationMs,
  }));
  check("discovered files", indexed.filesDiscovered > 15, String(indexed.filesDiscovered));
  check("indexed without failures", indexed.filesFailed === 0, JSON.stringify(indexed.failures?.slice(0,3)));
  check("chunks created", indexed.chunksIndexed > 25, String(indexed.chunksIndexed));

  console.log("\n== incremental re-index (should skip) ==");
  const reindexed = parse(await client.callTool({
    name: "index_paths",
    arguments: { paths: [path.join(repoRoot, "src")], include: ["**/*.ts"], collection: "selftest" },
  }));
  check("all unchanged files skipped", reindexed.filesIndexed === 0 && reindexed.filesSkippedUnchanged === indexed.filesIndexed,
    `indexed=${reindexed.filesIndexed} skipped=${reindexed.filesSkippedUnchanged}`);
  check("chunk count stable", reindexed.chunksIndexed === 0);

  console.log("\n== search: code symbol ==");
  const codeHit = parse(await client.callTool({
    name: "search",
    arguments: { query: "how are documents chunked and embedded into the vector database", collection: "selftest", limit: 5, uriPrefixes: [path.join(repoRoot, "src", "ingest").replace(/\\/g, "/")] },
  }));
  console.log("  hits:");
  for (const r of codeHit.results ?? []) {
    console.log(`    ${r.score}  ${r.uri.split(/[\\/]/).pop()}:${r.start_line}  ${(r.text ?? "").slice(0, 70).replace(/\n/g, " ")}`);
  }
  check("search returned hits", (codeHit.results ?? []).length > 0);
  const ingestDir = path.join(repoRoot, "src", "ingest").replace(/\\/g, "/");
  check("uriPrefix filter confines hits to src/ingest", (codeHit.results ?? []).length > 0 &&
    (codeHit.results ?? []).every((r) => r.uri.startsWith(ingestDir)),
    (codeHit.results ?? []).map((r) => r.uri).join(","));
  check("hits are real distinct chunks", (codeHit.results ?? []).length > 0 &&
      new Set((codeHit.results ?? []).map((r) => r.chunk_id)).size === (codeHit.results ?? []).length,
    (codeHit.results ?? []).map((r) => `${r.uri.split(/[\\/]/).pop()}:${r.chunk_id}`).join(","));
  check("scores are valid cosine", (codeHit.results ?? []).every((r) => r.score > -0.01 && r.score <= 1.0001));

  console.log("\n== search: specific symbol ==");
  const symHit = parse(await client.callTool({
    name: "search",
    arguments: { query: "delete a collection permanently", collection: "selftest", limit: 5 },
  }));
  console.log("  hits:");
  for (const r of symHit.results ?? []) {
    console.log(`    ${r.score}  ${r.uri.split(/[\\/]/).pop()}:${r.start_line}  ${(r.text ?? "").slice(0, 70).replace(/\n/g, " ")}`);
  }
  const serverHit = (symHit.results ?? []).find((r) => /server\.ts$/.test(r.uri));
  check("finds drop_collection in server.ts", serverHit !== undefined,
    (symHit.results ?? []).map((r) => r.uri.split(/[\\/]/).pop()).join(","));

  console.log("\n== search: Russian query against Russian text ==");
  const ruNote = parse(await client.callTool({
    name: "index_text",
    arguments: {
      collection: "selftest",
      uri: "memory/russian-note.md",
      title: "Заметка о векторном поиске",
      kind: "note",
      text: "Векторный поиск работает так: текст разбивается на фрагменты, для каждого вычисляется эмбеддинг, затем ищется ближайший вектор по косинусному расстоянию. Косинусное расстояние хорошо работает для смыслового сходства.",
    },
  }));
  check("russian note indexed", ruNote.ok === true && ruNote.chunks > 0, JSON.stringify(ruNote));
  const ruSearch = parse(await client.callTool({
    name: "search",
    arguments: { query: "как ищут похожие по смыслу фрагменты текста", collection: "selftest", limit: 3 },
  }));
  console.log("  hits:");
  for (const r of ruSearch.results ?? []) {
    console.log(`    ${r.score}  ${r.uri}  ${(r.text ?? "").slice(0, 60).replace(/\n/g, " ")}`);
  }
  check("russian query finds russian note", (ruSearch.results ?? []).some((r) => /russian-note/.test(r.uri)),
    (ruSearch.results ?? []).map((r) => `${r.uri}@${r.score}`).join(","));
  check("russian note detected as language ru", ruSearch.results?.find((r) => /russian-note/.test(r.uri))?.language === "ru",
    String(ruSearch.results?.find((r) => /russian-note/.test(r.uri))?.language));

  console.log("\n== get_context expansion ==");
  const topHit = (codeHit.results ?? [])[0];
  if (topHit) {
    const ctx = parse(await client.callTool({
      name: "get_context",
      arguments: { chunk_id: topHit.chunk_id, before: 2, after: 2 },
    }));
    check("context expanded", ctx.ok === true && ctx.chunks.length >= 1, JSON.stringify({ n: ctx.chunks?.length }));
    check("context has same uri", ctx.uri === topHit.uri, `${ctx.uri} vs ${topHit.uri}`);
    check("context includes center ordinal", ctx.chunks.some((c) => c.ordinal === topHit.ordinal));
    console.log(`  uri=${ctx.uri?.split(/[\\/]/).pop()} chunks=${ctx.chunks?.length} around ordinal ${topHit.ordinal}`);
  } else {
    check("get_context had a hit to expand", false);
  }

  console.log("\n== get_chunk ==");
  if (topHit) {
    const chunk = parse(await client.callTool({ name: "get_chunk", arguments: { chunk_id: topHit.chunk_id } }));
    check("chunk fetched", chunk.ok === true && typeof chunk.text === "string" && chunk.text.length > 0);
    check("chunk has line range", chunk.start_line !== null);
  }

  console.log("\n== filters ==");
  const langFiltered = parse(await client.callTool({
    name: "search",
    arguments: { query: "embedding vector model search", collection: "selftest", limit: 10, languages: ["en"] },
  }));
  check("language filter returns results", (langFiltered.results ?? []).length > 0, JSON.stringify(langFiltered.total));
  check("language filter excludes russian note", !(langFiltered.results ?? []).some((r) => /russian-note/.test(r.uri)),
    JSON.stringify((langFiltered.results ?? []).map((r) => r.uri)));
  check("language filter keeps only en", (langFiltered.results ?? []).every((r) => r.language === "en"),
    JSON.stringify((langFiltered.results ?? []).map((r) => r.language)));

const minScore = parse(await client.callTool({
    name: "search",
    arguments: { query: "chunking", collection: "selftest", limit: 100, minScore: 0.12 },
  }));
  check("minScore filter is strict", (minScore.results ?? []).length > 0 && (minScore.results ?? []).every((r) => r.score >= 0.12),
    JSON.stringify((minScore.results ?? []).map((r) => r.score)));
  const unfiltered = parse(await client.callTool({
    name: "search",
    arguments: { query: "chunking", collection: "selftest", limit: 100 },
  }));
  check("minScore reduces the result set", minScore.total < unfiltered.total, `${minScore.total} vs ${unfiltered.total}`);

  const kindFiltered = parse(await client.callTool({
    name: "search",
    arguments: { query: "векторный поиск", collection: "selftest", limit: 5, kinds: ["note"] },
  }));
  check("kind filter returns only notes", (kindFiltered.results ?? []).length > 0 &&
    (kindFiltered.results ?? []).every((r) => r.kind === "note"),
    JSON.stringify((kindFiltered.results ?? []).map((r) => r.kind)));

  const uriFiltered = parse(await client.callTool({
    name: "search",
    arguments: { query: "chunking code", collection: "selftest", limit: 20, uriPrefixes: [path.join(repoRoot, "src", "chunking").replace(/\\/g, "/")] },
  }));
  check("uriPrefix filter returns results", (uriFiltered.results ?? []).length > 0, JSON.stringify(uriFiltered.total));
  check("uriPrefix filter respects the prefix", (uriFiltered.results ?? []).every((r) => /src[/\\]chunking/.test(r.uri)),
    JSON.stringify((uriFiltered.results ?? []).map((r) => r.uri)));

  const exactUri = parse(await client.callTool({
    name: "search",
    arguments: { query: "anything", collection: "selftest", limit: 20, uris: [path.join(repoRoot, "src", "chunking", "code.ts").replace(/\\/g, "/")] },
  }));
  check("exact uri filter works", exactUri.total > 0 && exactUri.results.every((r) => /code\.ts$/.test(r.uri)),
    JSON.stringify(exactUri.results?.map((r) => r.uri)));

  const noMatch = parse(await client.callTool({
    name: "search",
    arguments: { query: "something", collection: "selftest", limit: 5, uriPrefixes: ["/definitely/not/here"] },
  }));
  check("non-matching filter returns empty not error", noMatch.ok === true && noMatch.total === 0);

  console.log("\n== list_sources / list_collections ==");
  const sources = parse(await client.callTool({ name: "list_sources", arguments: { collection: "selftest", limit: 5 } }));
  check("list_sources returns docs", sources.ok === true && sources.total >= 20, `total=${sources.total}`);
  check("list_sources paginates", sources.returned === 5, `returned=${sources.returned}`);
  check("documents have chunk counts", sources.documents.every((d) => d.chunks > 0));
  console.log("  sample:", sources.documents.slice(0, 3).map((d) => `${d.uri.split(/[\\/]/).pop()}(${d.chunks})`).join(", "));

  const cols = parse(await client.callTool({ name: "list_collections", arguments: {} }));
  check("collection listed", cols.collections?.some((c) => c.name === "selftest"));
  const col = cols.collections.find((c) => c.name === "selftest");
  console.log("  collection:", JSON.stringify(col));
  check("collection stats consistent", col.documents === sources.total || col.documents > 0);

  console.log("\n== errors are graceful ==");
  const missingCol = parse(await client.callTool({ name: "search", arguments: { query: "x", collection: "nope" } }));
  check("missing collection returns a helpful hint", missingCol.ok === true &&
    /not found/.test(missingCol.hint ?? "") && /selftest/.test(missingCol.hint ?? ""),
    JSON.stringify(missingCol.hint));

  const badName = parse(await client.callTool({ name: "index_text", arguments: { text: "hi", uri: "a.md", collection: "bad name!" } }));
  check("invalid collection name rejected", badName.ok === false && badName.error?.code === "invalid_collection",
    JSON.stringify(badName.error));

  const delNoSel = parse(await client.callTool({ name: "delete_sources", arguments: { collection: "selftest" } }));
  check("delete requires selector", delNoSel.ok === false && delNoSel.error?.code === "missing_selector",
    JSON.stringify(delNoSel.error));

  const dropNoConfirm = parse(await client.callTool({ name: "drop_collection", arguments: { collection: "selftest", confirm: false } }));
  check("drop requires confirm", dropNoConfirm.ok === false && dropNoConfirm.error?.code === "confirmation_required",
    JSON.stringify(dropNoConfirm.error));

  const missingPath = parse(await client.callTool({ name: "index_paths", arguments: { paths: ["Z:/does/not/exist"], collection: "selftest" } }));
  check("nonexistent path handled", missingPath.ok === true && missingPath.filesDiscovered === 0);

  console.log("\n== delete_sources ==");
  const before = parse(await client.callTool({ name: "list_sources", arguments: { collection: "selftest", limit: 1 } }));
  const del = parse(await client.callTool({
    name: "delete_sources",
    arguments: { collection: "selftest", uriPrefixes: [path.join(repoRoot, "src", "util").replace(/\\/g, "/")] },
  }));
  check("deleted documents", del.ok === true && del.documents_deleted === 2, JSON.stringify(del));
  const after = parse(await client.callTool({ name: "list_sources", arguments: { collection: "selftest", limit: 1 } }));
  check("document count dropped", after.total === before.total - 2, `${before.total} -> ${after.total}`);
  const noVectorLeak = parse(await client.callTool({
    name: "search", arguments: { query: "mutex semaphore timeout", collection: "selftest", limit: 3 }
  }));
  check("deleted docs gone from search", !(noVectorLeak.results ?? []).some((r) => /util[/\\]async/.test(r.uri)),
    JSON.stringify((noVectorLeak.results ?? []).map((r) => r.uri)));

  console.log("\n== drop_collection ==");
  const drop = parse(await client.callTool({ name: "drop_collection", arguments: { collection: "selftest", confirm: true } }));
  check("collection dropped", drop.ok === true && drop.dropped === true);
  const colsAfter = parse(await client.callTool({ name: "list_collections", arguments: {} }));
  check("collection gone", !colsAfter.collections?.some((c) => c.name === "selftest"));

  console.log("\n== recreate after drop (vec table must be rebuilt) ==");
  const reindex = parse(await client.callTool({
    name: "index_paths",
    arguments: { paths: [path.join(repoRoot, "src", "config.ts")], collection: "selftest" },
  }));
  check("reindexed into fresh collection", reindex.ok === true && reindex.filesIndexed === 1 && reindex.chunksIndexed > 0,
    JSON.stringify({ i: reindex.filesIndexed, c: reindex.chunksIndexed }));
  const reSearch = parse(await client.callTool({
    name: "search", arguments: { query: "configuration loading and environment variables", collection: "selftest", limit: 3 }
  }));
  check("search works after recreate", (reSearch.results ?? []).length > 0);

  await client.close();

  console.log(`\n${"=".repeat(46)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(46)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});