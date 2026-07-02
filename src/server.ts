#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { actorFromEnv } from "./actor.js";
import { createMemoryMcpServer } from "./mcp.js";
import { createStoreFromEnv } from "./store-factory.js";

async function main() {
  const actor = actorFromEnv();
  const store = createStoreFromEnv();
  const server = createMemoryMcpServer(actor, store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("agents-memory-sidecar failed:", error);
  process.exit(1);
});
