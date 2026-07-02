import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultBaseUrl = "http://127.0.0.1:18790";
const defaultEnvPath = join(homedir(), ".config/agents-memory/tokens/pi.env");

export default function agentMemoryExtension(pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerTool({
    name: "agent_memory_search",
    label: "Memory Search",
    description: "Search long-term shared agent memory for a project.",
    promptSnippet: "Search shared long-term memory for a project.",
    promptGuidelines: [
      "Use agent_memory_search before changing a known server or project when prior operations may contain relevant context.",
    ],
    parameters: Type.Object({
      project: Type.String({ minLength: 1 }),
      query: Type.String({ minLength: 1 }),
      tenant: Type.Optional(Type.String({ minLength: 1 })),
      namespace: Type.Optional(Type.String({ minLength: 1 })),
      kind: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, signal) {
      return jsonToolResult(
        await request(config, "/v1/memory/search", {
          method: "POST",
          body: {
            tenant: params.tenant ?? "default",
            project: params.project,
            query: params.query,
            namespace: params.namespace,
            kind: params.kind,
            limit: params.limit ?? 5,
          },
          signal,
        }),
      );
    },
  });

  pi.registerTool({
    name: "agent_memory_get",
    label: "Memory Get",
    description: "Read the full body of one shared memory item by id.",
    promptSnippet: "Read a full shared memory item returned by agent_memory_search.",
    promptGuidelines: [
      "Use agent_memory_get after agent_memory_search when the excerpt is not enough to act safely.",
    ],
    parameters: Type.Object({
      project: Type.String({ minLength: 1 }),
      id: Type.String({ minLength: 1 }),
      tenant: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolCallId, params, signal) {
      const search = new URLSearchParams({
        tenant: params.tenant ?? "default",
        project: params.project,
      });
      return jsonToolResult(await request(config, `/v1/memory/${encodeURIComponent(params.id)}?${search}`, { signal }));
    },
  });

  pi.registerTool({
    name: "agent_memory_context_get",
    label: "Project Context Get",
    description: "Read shared project context such as paths, deployment commands, ports, and conventions.",
    promptSnippet: "Read shared project context.",
    promptGuidelines: [
      "Use agent_memory_context_get before operating on a project with known deployment or recovery conventions.",
    ],
    parameters: Type.Object({
      project: Type.String({ minLength: 1 }),
      tenant: Type.Optional(Type.String({ minLength: 1 })),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    async execute(_toolCallId, params, signal) {
      const search = new URLSearchParams({
        tenant: params.tenant ?? "default",
        project: params.project,
      });
      for (const key of params.keys ?? []) search.append("key", key);
      return jsonToolResult(await request(config, `/v1/context?${search}`, { signal }));
    },
  });

  pi.registerTool({
    name: "agent_memory_observation_add",
    label: "Observation Add",
    description: "Append a short-lived process observation to shared memory.",
    promptSnippet: "Append a short-lived observation to shared memory.",
    promptGuidelines: [
      "Use agent_memory_observation_add after validating an operational fact that may help the next agent session.",
    ],
    parameters: Type.Object({
      project: Type.String({ minLength: 1 }),
      observation: Type.String({ minLength: 1 }),
      tenant: Type.Optional(Type.String({ minLength: 1 })),
      session_id: Type.Optional(Type.String({ minLength: 1 })),
      ttl_days: Type.Optional(Type.Number({ minimum: 1, maximum: 180 })),
    }),
    async execute(_toolCallId, params, signal) {
      return jsonToolResult(
        await request(config, "/v1/observations", {
          method: "POST",
          body: {
            tenant: params.tenant ?? "default",
            project: params.project,
            session_id: params.session_id,
            observation: params.observation,
            ttl_days: params.ttl_days ?? 30,
          },
          signal,
        }),
      );
    },
  });
}

interface Config {
  baseUrl: string;
  bearerToken: string;
}

function loadConfig(): Config {
  const envFile = parseEnvFile(process.env.AGENT_MEMORY_PI_ENV_FILE ?? defaultEnvPath);
  const baseUrl = process.env.AGENT_MEMORY_HTTP_BASE_URL ?? envFile.AGENT_MEMORY_HTTP_BASE_URL ?? defaultBaseUrl;
  const bearerToken = process.env.AGENT_MEMORY_HTTP_BEARER_TOKEN ?? envFile.AGENT_MEMORY_HTTP_BEARER_TOKEN;
  if (!bearerToken) {
    throw new Error(`Missing AGENT_MEMORY_HTTP_BEARER_TOKEN; expected env var or ${defaultEnvPath}`);
  }
  return { baseUrl, bearerToken };
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

async function request(
  config: Config,
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method ?? "GET",
    signal: options.signal,
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      "content-type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`agent memory HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function jsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: { result: value },
  };
}
