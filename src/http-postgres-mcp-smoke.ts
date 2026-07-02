import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const wrapperPath = process.env.AGENT_MEMORY_MCP_WRAPPER ?? "dist/server.js";
const bearerToken = requiredEnv("AGENT_MEMORY_HTTP_BEARER_TOKEN");
const baseUrl = process.env.AGENT_MEMORY_HTTP_BASE_URL ?? "http://127.0.0.1:18790";
const agentId = process.env.AGENT_MEMORY_AGENT_ID ?? "smoke-agent";
const runtime = process.env.AGENT_MEMORY_RUNTIME ?? "smoke";
const role = process.env.AGENT_MEMORY_ROLE ?? "writer";
const sourceRef = `${runtime}:http-postgres-mcp-smoke`;

function parseToolJson(result: unknown): any {
  const content = (result as any).content;
  assert.ok(Array.isArray(content), "tool result has content array");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

async function main() {
  const client = new Client({ name: "http-postgres-mcp-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "/usr/local/bin/node",
    args: [wrapperPath],
    stderr: "pipe",
    env: {
      AGENT_MEMORY_BACKEND: "http",
      AGENT_MEMORY_HTTP_BASE_URL: baseUrl,
      AGENT_MEMORY_HTTP_BEARER_TOKEN: bearerToken,
      AGENT_MEMORY_AGENT_ID: agentId,
      AGENT_MEMORY_RUNTIME: runtime,
      AGENT_MEMORY_ROLE: role,
      AGENT_MEMORY_TENANT: "default",
      AGENT_MEMORY_PROJECTS: "*",
    },
  });

  try {
    await client.connect(transport);

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

    const context = parseToolJson(
      await client.callTool({
        name: "project_context_get",
        arguments: { tenant: "default", project: "server-ops" },
      }),
    );
    assert.ok(context.contexts.length >= 1, "expected seeded project contexts");

    const search = parseToolJson(
      await client.callTool({
        name: "memory_search",
        arguments: { tenant: "default", project: "server-ops", query: "shared memory", limit: 3 },
      }),
    );
    assert.ok(search.items.length >= 1, "expected seeded shared memory");

    const full = parseToolJson(
      await client.callTool({
        name: "memory_get",
        arguments: { tenant: "default", project: "server-ops", id: search.items[0].id },
      }),
    );
    assert.equal(full.id, search.items[0].id);

    const now = new Date().toISOString();
    const memoryAdd = parseToolJson(
      await client.callTool({
        name: "memory_add",
        arguments: {
          tenant: "default",
          project: "agents-memory-sidecar",
          namespace: "validation",
          kind: "validation",
          title: `${runtime} MCP PostgreSQL validation ${now}`,
          body: `Independent stdio MCP client validated wrapper -> HTTP sidecar -> PostgreSQL at ${now}.`,
          summary: `${runtime} MCP PostgreSQL smoke validation completed.`,
          source_type: "agent",
          source_ref: sourceRef,
          confidence: 1,
        },
      }),
    );
    assert.equal(memoryAdd.accepted, true);
    assert.ok(memoryAdd.id);

    const observation = parseToolJson(
      await client.callTool({
        name: "agent_observation_add",
        arguments: {
          tenant: "default",
          project: "agents-memory-sidecar",
          observation: `Validated MCP wrapper through HTTP sidecar to PostgreSQL at ${now}.`,
          metadata: { smoke: "http-postgres-mcp" },
          ttl_days: 7,
        },
      }),
    );
    assert.equal(observation.accepted, true);
    assert.ok(observation.id);

    const denied = parseToolJson(
      await client.callTool({
        name: "project_context_set",
        arguments: {
          tenant: "default",
          project: "agents-memory-sidecar",
          key: "writer-denied-validation",
          value: true,
          source_ref: sourceRef,
        },
      }),
    );
    assert.equal(denied.error, "permission_denied");

    console.log("http postgres mcp smoke ok");
  } finally {
    await client.close();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
