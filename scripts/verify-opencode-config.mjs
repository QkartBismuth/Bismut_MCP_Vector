import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

const raw = fs.readFileSync(configPath, "utf8");
const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));

const servers = Object.entries(config.mcp ?? {});
if (servers.length === 0) {
  console.error(`FAIL: no mcp servers registered in ${configPath}`);
  process.exit(1);
}

console.log(`config : ${configPath}`);
console.log(`cwd    : ${cwd}`);
console.log(`servers: ${servers.map(([n]) => n).join(", ")}`);
console.log();

let failures = 0;

for (const [name, entry] of servers) {
  console.log(`--- ${name} ---`);

  if (entry.enabled === false) {
    console.log(`  SKIP  disabled in config`);
    console.log();
    continue;
  }

  if (entry.type !== "local") {
    if (entry.type === "remote") {
      console.log(`  SKIP  remote server, not verified locally`);
      console.log();
      continue;
    }
    console.log(`  FAIL  unexpected type "${entry.type}" (opencode requires "type")`);
    failures += 1;
    console.log();
    continue;
  }

  if (!Array.isArray(entry.command) || entry.command.length === 0) {
    console.log(`  FAIL  command must be a non-empty array of strings`);
    failures += 1;
    console.log();
    continue;
  }
  if (!entry.command.every((p) => typeof p === "string")) {
    console.log(`  FAIL  command array must contain only strings`);
    failures += 1;
    console.log();
    continue;
  }

  const [cmd, ...args] = entry.command;
  console.log(`  cmd    ${cmd} ${args.join(" ")}`);

  if (!fs.existsSync(cmd)) {
    console.log(`  FAIL  executable not found: ${cmd}`);
    failures += 1;
    console.log();
    continue;
  }
  for (const a of args) {
    if (!fs.existsSync(a)) {
      console.log(`  FAIL  argument path not found: ${a}`);
      failures += 1;
    }
  }

  for (const [k, v] of Object.entries(entry.environment ?? {})) {
    if (typeof v === "string" && /^[A-Za-z]:[\\/]/.test(v) && !fs.existsSync(v)) {
      console.log(`  WARN  env ${k} path does not exist: ${v}`);
    }
  }

  const chunks = [];
  const transport = new StdioClientTransport({
    command: cmd,
    args,
    cwd,
    env: { ...process.env, ...(entry.environment ?? {}) },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c) => chunks.push(c.toString()));

  try {
    const client = new Client({ name: "config-verify", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`  PASS  handshake ok, ${tools.length} tools`);

    const names = tools.map((t) => t.name).sort();
    console.log(`        ${names.join(", ")}`);

    if (tools.length === 0) {
      console.log(`  FAIL  server exposed no tools`);
      failures += 1;
    }

    const stats = tools.find((t) => t.name === "stats");
    if (stats) {
      const res = await client.callTool({ name: "stats", arguments: {} });
      const parsed = res.structuredContent ?? JSON.parse(res.content[0].text);
      if (parsed.ok) {
        console.log(`        db: ${parsed.database_path}`);
        console.log(`        embedding: ${JSON.stringify(parsed.embedding)}`);
      } else {
        console.log(`  FAIL  stats returned ok=false`);
        failures += 1;
      }
    }

    await client.close();
  } catch (err) {
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    failures += 1;
  }

  const stderr = chunks.join("").trim();
  if (stderr) {
    console.log(`  stderr:`);
    for (const line of stderr.split("\n")) console.log(`        ${line}`);
  }
  console.log();
}

if (failures > 0) {
  console.log(`RESULT: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`RESULT: all ${servers.length} registered server(s) healthy`);