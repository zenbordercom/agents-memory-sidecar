import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpApp, listenUrl } from "./http.js";
import { HttpStore } from "./http-store.js";
import { createMemoryMcpServer } from "./mcp.js";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const storePath = resolve("data/http-bridge-smoke-store.json");

function parseToolJson(result: unknown): any {
  const content = (result as any).content;
  assert.ok(Array.isArray(content), "tool result has content array");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

async function main() {
  await rm(storePath, { force: true });

  const store = new FakeStore(storePath);
  const admin: Actor = {
    tenant: "default",
    agentId: "http-bridge-seed",
    runtime: "manual",
    workspace: process.cwd(),
    role: "admin",
    projects: ["*"],
  };
  const writer: Actor = {
    tenant: "default",
    agentId: "http-bridge-writer",
    runtime: "codex",
    workspace: process.cwd(),
    role: "writer",
    projects: ["*"],
  };

  await store.contextSet(admin, {
    tenant: "default",
    project: "server-ops",
    key: "deployment",
    value: { manager: "systemd" },
    source_ref: "manual:http-bridge-smoke",
  });
  await store.memoryAdd(admin, {
    tenant: "default",
    project: "server-ops",
    namespace: "ops",
    kind: "fact",
    title: "HTTP bridge smoke seed",
    body: "The MCP wrapper can call the HTTP sidecar through HttpStore.",
    source_type: "manual",
    source_ref: "manual:http-bridge-smoke",
  });

  const httpServer = createHttpApp(writer, store);
  await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = listenUrl(httpServer);

  const mcpServer = createMemoryMcpServer(writer, new HttpStore(baseUrl));
  const client = new Client({ name: "http-bridge-smoke", version: "0.2.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const context = parseToolJson(
      await client.callTool({
        name: "project_context_get",
        arguments: { tenant: "default", project: "server-ops", keys: ["deployment"] },
      }),
    );
    assert.equal(context.contexts.length, 1);

    const search = parseToolJson(
      await client.callTool({
        name: "memory_search",
        arguments: { tenant: "default", project: "server-ops", query: "HTTP bridge" },
      }),
    );
    assert.equal(search.items.length, 1);

    const denied = parseToolJson(
      await client.callTool({
        name: "project_context_set",
        arguments: {
          tenant: "default",
          project: "server-ops",
          key: "denied",
          value: true,
        },
      }),
    );
    assert.equal(denied.error, "permission_denied");

    console.log("http bridge smoke ok");
  } finally {
    await client.close();
    await mcpServer.close();
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
