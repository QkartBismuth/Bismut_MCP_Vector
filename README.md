# Bismut Vector MCP

A local vector database exposed over the Model Context Protocol. Works with any
MCP client: opencode, Claude Code/Desktop, Hermes, Cursor, Zed, Windsurf, and
anything else that speaks MCP over stdio.

Everything runs on your machine. Embeddings are computed in-process with a local
ONNX model, vectors live in a single SQLite file, and nothing is sent over the
network.

## Why it is built this way

| Choice | Reason |
|---|---|
| `node:sqlite` + `sqlite-vec` | Zero native compilation. The extension ships as a prebuilt npm optional dependency, so `npm install` is enough on every platform. |
| Local ONNX embeddings | No API keys, no network, no data leaving the machine. Works offline. |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 384 dimensions, handles 50+ languages well. Measured much better separation than `multilingual-e5-small` (0.66 vs -0.01 for related/unrelated pairs, against 0.90 vs 0.78). |
| Cosine distance | Vectors are L2-normalized, so cosine similarity is exact and scores are directly interpretable: `1.0` is identical, `0.0` is orthogonal. |
| One `vec0` table per collection | Lets different collections use different models and dimensions. |

## Install

```powershell
npm install
npm run build
```

Requires Node 22.5+ (uses the built-in `node:sqlite`). Developed and tested on
Node 24.

The embedding model downloads once on first use (~120 MB) into
`.bismut/cache`. Later runs start instantly and work offline.

## Connect an editor

Registered in opencode's global config (`~/.config/opencode/opencode.jsonc`) as
`bismut-vector`. Verify any time:

```powershell
npm run verify:opencode
npm run verify:opencode -- /path/to/some-project
```

That reads your live opencode config, walks every registered server, and performs
a real MCP handshake with the exact command and environment values it finds
there.

For other editors, copy the block from `examples/`:

- `examples/opencode.json` — opencode scope and overrides
- `examples/claude.md` — Claude Code and Desktop
- `examples/other-editors.md` — Cursor, Zed, Windsurf, Hermes, others

The common shape is:

```json
{
  "mcpServers": {
    "bismut-vector": {
      "command": "node",
      "args": ["/absolute/path/to/Bismut_MCP_Vector/dist/index.js"],
      "env": { "BISMUT_COLLECTION": "myproject" }
    }
  }
}
```

opencode config is reloaded on restart, not hot-reloaded.

## Tools

| Tool | Purpose |
|---|---|
| `index_paths` | Index files or directories. Re-running skips unchanged files. |
| `index_text` | Index arbitrary text: notes, memory, logs, pasted context. |
| `search` | Semantic search with path, language, and kind filters. |
| `get_context` | Expand a search hit into surrounding chunks. |
| `get_chunk` | Fetch one chunk in full. |
| `list_sources` | List what is indexed. |
| `list_collections` | List collections with model, dimension, and counts. |
| `delete_sources` | Remove documents by id, exact path, or path prefix. |
| `drop_collection` | Delete a whole collection. Requires `confirm: true`. |
| `stats` | Server, database, and embedding model diagnostics. |

A typical agent session:

1. `index_paths` on the repository once.
2. `search` with a path filter instead of guessing filenames.
3. `get_context` when a result looks truncated mid-function.

## Chunking

Chunking is language-aware, which matters more for retrieval quality than
embedding model choice:

- **Markdown** splits on headings and carries the heading breadcrumb
  (`Architecture > Embeddings`) into every chunk.
- **Code** splits at top-level symbol boundaries, tracking brace depth while
  skipping strings, template literals, and comments. One function or class per
  chunk, named in the chunk header. Python and other indent languages split on
  `def`/`class` blocks instead.
- **Prose and config files** pack paragraphs up to a token target with overlap.

Every chunk embeds with a header (`file:`, `title:`, `lang:`, and the symbol
name) prepended to its body. This measurably improves retrieval for short chunks,
where the body alone gives the embedder too little to work with.

Line ranges are preserved on every chunk, so results can be opened directly.

## Configuration

All settings are environment variables. Optionally use a `.bismutrc.json` in the
working directory instead.

| Variable | Default | Meaning |
|---|---|---|
| `BISMUT_DB_PATH` | `./.bismut/vectors.db` | SQLite database file |
| `BISMUT_CACHE_DIR` | `<db dir>/cache` | Model download cache |
| `BISMUT_COLLECTION` | `default` | Default collection name |
| `BISMUT_EMBED_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Any transformers.js model |
| `BISMUT_EMBED_DTYPE` | `q8` | `q8`, `fp16`, `fp32`, `quantized` |
| `BISMUT_EMBED_DEVICE` | `cpu` | `cpu`, `gpu`, `auto` |
| `BISMUT_EMBED_PROVIDER` | `local` | `local` or `openai` |
| `BISMUT_BATCH_SIZE` | `16` | Embeddings per forward pass |
| `BISMUT_CHUNK_TOKENS` | `320` | Target chunk size |
| `BISMUT_CHUNK_OVERLAP` | `60` | Overlap between chunks |
| `BISMUT_MAX_FILE_BYTES` | `1048576` | Skip files larger than this |
| `BISMUT_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, `debug`, `trace` |

To use a cloud embedding endpoint instead:

```json
{
  "BISMUT_EMBED_PROVIDER": "openai",
  "BISMUT_EMBED_MODEL": "text-embedding-3-small",
  "BISMUT_API_KEY": "sk-...",
  "BISMUT_API_BASE": "https://api.openai.com/v1"
}
```

`BISMUT_API_BASE` works with any OpenAI-compatible endpoint (Ollama,
LM Studio, vLLM).

Changing the model changes the vector dimensionality, so it requires a new
collection. The server refuses to mix models within one collection rather than
silently producing nonsense results.

## Storage layout

A collection's vectors live in its own `vec0` virtual table. Chunk text and
document metadata live in ordinary tables, joined on the vector row id.

Filters are resolved to a `doc_id` list before the vector query, so path and
language filters are applied during the ANN traversal rather than after `k` is
taken. Applying them afterwards is the classic sqlite-vec mistake: it returns
empty results whenever the nearest `k` neighbours happen to fall outside the
filter.

Embeddings are cached by content hash, so re-indexing only re-embeds what
actually changed.

## Development

```powershell
npm run typecheck     # tsc --noEmit with strict + unused checks
npm test              # 49 end-to-end assertions over the real MCP protocol
npm run test:chunks   # print chunk boundaries per language
node scripts/probe-embed.mjs   # check embedding quality for a model
```

`npm test` spawns the built server as a subprocess and drives it with a real MCP
client, so it exercises the actual stdio transport, JSON-RPC framing, and zod
schema conversion rather than calling internals.

## Known limits

- Chunking uses structural heuristics, not a full parser. It is accurate for
  normal source files but not a substitute for an AST. Nested blocks inside a
  large `impl` or class body stay in one chunk until they exceed the token
  target.
- `index_paths` walks directories serially, which is fast enough for typical
  repositories but noticeable on very large monorepos.
- PDF indexing uses `unpdf` and only reads text layers. Scanned PDFs yield
  nothing; there is no OCR.
- There is no hybrid keyword/vector search. Pure semantic search can miss an
  exact identifier string, so pass `minScore` deliberately and use path filters
  to narrow.