import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canAdmin, canRead, canWrite } from "./actor.js";
import { errorResult, jsonResult } from "./result.js";
import { scanForSecrets } from "./security.js";
import type { MemoryStore } from "./store.js";
import type { Actor } from "./types.js";

const tenant = z.string().min(1).default("default");
const project = z.string().min(1);
const namespace = z.string().min(1).default("ops");
const sourceType = z.enum(["user", "agent", "file", "command", "url", "system", "manual", "import"]);
const metadata = z.record(z.string(), z.unknown()).default({});
const searchMode = z.enum(["keyword", "semantic", "hybrid"]);

// Single source of truth for the declared version: resolve the package.json that
// ships with this build (works unchanged from src/ via tsx and from dist/).
const require = createRequire(import.meta.url);
const declaredVersion = (require("../package.json") as { version: string }).version;

export function createMemoryMcpServer(actor: Actor, store: MemoryStore): McpServer {
  const server = new McpServer({
    name: "agents-memory-sidecar",
    version: declaredVersion,
  });

  server.registerTool(
    "memory_search",
    {
      title: "Search shared memory",
      description: "Search long-term shared memory within a project.",
      inputSchema: {
        tenant,
        project,
        namespace: z.string().min(1).optional(),
        kind: z.string().min(1).optional(),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
        mode: searchMode.optional(),
        embedding_model: z.string().min(1).optional(),
        query_embedding: z.array(z.number()).min(1).optional(),
      },
    },
    async (input) => {
      if (!canRead(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const items = await store.memorySearch(input);
      return jsonResult({ items });
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Get shared memory item",
      description: "Read the full body of one memory item returned by memory_search.",
      inputSchema: {
        tenant,
        project,
        id: z.string().uuid(),
      },
    },
    async (input) => {
      if (!canRead(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const item = await store.memoryGet(input);
      if (!item) {
        return errorResult("not_found");
      }
      return jsonResult(item);
    },
  );

  server.registerTool(
    "project_context_get",
    {
      title: "Get project context",
      description: "Read project-level context such as paths, deployment commands, ports, and conventions.",
      inputSchema: {
        tenant,
        project,
        keys: z.array(z.string().min(1)).optional(),
      },
    },
    async (input) => {
      if (!canRead(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const contexts = await store.contextGet(input);
      return jsonResult({ project: input.project, contexts });
    },
  );

  server.registerTool(
    "memory_add",
    {
      title: "Add shared memory",
      description: "Append a long-term useful memory item after sensitive information scanning.",
      inputSchema: {
        tenant,
        project,
        namespace,
        kind: z.string().min(1),
        title: z.string().min(1).optional(),
        body: z.string().min(1).max(64_000),
        summary: z.string().min(1).max(4_000).optional(),
        metadata,
        source_type: sourceType,
        source_ref: z.string().min(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    async (input) => {
      if (!canWrite(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const warnings = scanForSecrets(input);
      if (warnings.length) {
        return jsonResult({ accepted: false, warnings });
      }

      const result = await store.memoryAdd(actor, input);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "agent_observation_add",
    {
      title: "Add agent observation",
      description: "Append a short-lived process observation. Actor fields are injected by the wrapper.",
      inputSchema: {
        tenant,
        project,
        session_id: z.string().min(1).optional(),
        observation: z.string().min(1).max(32_000),
        metadata,
        ttl_days: z.number().int().min(1).max(180).default(30),
      },
    },
    async (input) => {
      if (!canWrite(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const warnings = scanForSecrets(input);
      if (warnings.length) {
        return jsonResult({ accepted: false, warnings });
      }

      const result = await store.observationAdd(actor, input);
      return jsonResult(result);
    },
  );

  server.registerTool(
    "project_context_set",
    {
      title: "Set project context",
      description: "Admin-only project context upsert. updated_by is derived from the wrapper token.",
      inputSchema: {
        tenant,
        project,
        key: z.string().min(1),
        value: z.unknown(),
        source_ref: z.string().min(1).optional(),
        note: z.string().min(1).optional(),
      },
    },
    async (input) => {
      if (!canAdmin(actor, input.tenant, input.project)) {
        return errorResult("permission_denied");
      }

      const warnings = scanForSecrets(input);
      if (warnings.length) {
        return jsonResult({ accepted: false, warnings });
      }

      const result = await store.contextSet(actor, input);
      return jsonResult(result);
    },
  );

  return server;
}
