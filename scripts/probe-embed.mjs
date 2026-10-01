import { pipeline, env } from "@huggingface/transformers";

const model = process.env.PROBE_MODEL ?? "Xenova/multilingual-e5-small";
const dtype = process.env.PROBE_DTYPE ?? "q8";

console.log("loading", model, dtype);
const t0 = Date.now();
const embed = await pipeline("feature-extraction", model, { dtype, device: "cpu" });
console.log("loaded in", Date.now() - t0, "ms");

const dims = [384];
for (const text of ["passage: Привет мир, это тест векторной базы данных", "query: как работает поиск по похожим векторам"]) {
  const t1 = Date.now();
  const out = await embed(text, { pooling: "mean", normalize: true });
  console.log("dim:", out.dims, "| ms:", Date.now() - t1, "| norm:", out.data.slice(0, 4).map((x) => +x.toFixed(4)));
  dims.push(out.dims.at(-1));
}

const a = await embed("query: что такое MCP протокол", { pooling: "mean", normalize: true });
const b = await embed("passage: MCP (Model Context Protocol) — протокол для подключения ИИ-агентов к инструментам", { pooling: "mean", normalize: true });
const c = await embed("passage: Рецепт приготовления борща: свёкла, капуста, мясо", { pooling: "mean", normalize: true });
const cos = (x, y) => x.data.reduce((s, v, i) => s + v * y.data[i], 0);
console.log("cos(related):", cos(a, b).toFixed(4), "| cos(unrelated):", cos(a, c).toFixed(4));
console.log("PROBE OK dims:", new Set(dims).size === 1 ? "consistent " + dims[0] : dims);
