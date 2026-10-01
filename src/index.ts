#!/usr/bin/env node
import { createServer } from "./server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { errorMessage, log } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  log.info(
    "starting bismut-vector-mcp",
    `db=${config.dbPath}`,
    `provider=${config.provider}`,
    `model=${config.model}`,
    `collection=${config.defaultCollection}`,
  );

  const { server, context } = await createServer(config);
  const transport = new StdioServerTransport();

  const close = async (code: number): Promise<void> => {
    try {
      await context.embeddings.dispose();
    } catch (err) {
      log.debug("dispose failed", String(err));
    }
    context.db.close();
    process.exit(code);
  };

  process.on("SIGINT", () => void close(0));
  process.on("SIGTERM", () => void close(0));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", String(reason));
  });

  await server.connect(transport);
  log.info("bismut-vector-mcp ready on stdio");
}

main().catch((err) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});