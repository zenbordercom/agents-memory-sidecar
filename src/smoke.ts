import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "./mcp.js";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const storePath = resolve("data/smoke-store.json");

function parseToolJson(result: unknown): any {
  const content = (result as any).content;
  assert.ok(Array.isArray(content), "tool result has content array");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

async function main() {
  await rm(storePath, { force: true });

  const actor: Actor = {
    tenant: "default",
    agentId: "smoke-admin",
    runtime: "smoke",
    workspace: process.cwd(),
    role: "admin",
    projects: ["server-ops", "demo-app"],
  };

  const server = createMemoryMcpServer(actor, new FakeStore(storePath));
  const client = new Client({ name: "agents-memory-smoke", version: "0.1.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "agent_observation_add",
    "memory_add",
    "memory_get",
    "memory_search",
    "project_context_get",
    "project_context_set",
  ]);

  const contextSet = parseToolJson(
    await client.callTool({
      name: "project_context_set",
      arguments: {
        tenant: "default",
        project: "server-ops",
        key: "deployment",
        value: { manager: "systemd", notes: "smoke test context" },
        source_ref: "manual:smoke",
      },
    }),
  );
  assert.equal(contextSet.accepted, true);

  const contextGet = parseToolJson(
    await client.callTool({
      name: "project_context_get",
      arguments: { tenant: "default", project: "server-ops", keys: ["deployment"] },
    }),
  );
  assert.equal(contextGet.contexts.length, 1);
  assert.equal(contextGet.contexts[0].updated_by, "smoke-admin");

  const memoryAdd = parseToolJson(
    await client.callTool({
      name: "memory_add",
      arguments: {
        tenant: "default",
        project: "server-ops",
        namespace: "incident",
        kind: "incident",
        title: "Demo deployment recovery note",
        body: "Recovered the demo deployment by restoring the service file and restarting the local process. This is a fake smoke-test memory.",
        summary: "Demo deployment recovery was validated in the smoke test.",
        source_type: "manual",
        source_ref: "manual:smoke",
        confidence: 1,
      },
    }),
  );
  assert.equal(memoryAdd.accepted, true);

  const duplicateAdd = parseToolJson(
    await client.callTool({
      name: "memory_add",
      arguments: {
        tenant: "default",
        project: "server-ops",
        namespace: "incident",
        kind: "incident",
        title: "Demo deployment recovery note",
        body: "Recovered the demo deployment by restoring the service file and restarting the local process. This is a fake smoke-test memory.",
        summary: "Demo deployment recovery was validated in the smoke test.",
        source_type: "manual",
      },
    }),
  );
  assert.equal(duplicateAdd.accepted, false);
  assert.deepEqual(duplicateAdd.warnings, ["duplicate_content"]);

  const rejectedSecret = parseToolJson(
    await client.callTool({
      name: "memory_add",
      arguments: {
        tenant: "default",
        project: "server-ops",
        namespace: "ops",
        kind: "fact",
        body: "Do not store this fake API token 1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
        source_type: "manual",
      },
    }),
  );
  assert.equal(rejectedSecret.accepted, false);
  assert.deepEqual(rejectedSecret.warnings, ["suspected_secret"]);

  const search = parseToolJson(
    await client.callTool({
      name: "memory_search",
      arguments: { tenant: "default", project: "server-ops", query: "demo deployment" },
    }),
  );
  assert.equal(search.items.length, 1);

  const full = parseToolJson(
    await client.callTool({
      name: "memory_get",
      arguments: { tenant: "default", project: "server-ops", id: search.items[0].id },
    }),
  );
  assert.equal(full.id, memoryAdd.id);

  const observation = parseToolJson(
    await client.callTool({
      name: "agent_observation_add",
      arguments: {
        tenant: "default",
        project: "server-ops",
        observation: "Smoke test verified MCP tool loop with fake storage.",
        ttl_days: 7,
      },
    }),
  );
  assert.equal(observation.accepted, true);

  await client.close();
  await server.close();

  console.log("smoke ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
