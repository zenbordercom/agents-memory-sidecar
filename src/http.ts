import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { actorFromEnv, canAdmin, canRead, canWrite } from "./actor.js";
import { scanForSecrets } from "./security.js";
import { createStoreFromEnv } from "./store-factory.js";
import type { Actor } from "./types.js";
import type { MemoryStore } from "./store.js";

const maxBodyBytes = 256 * 1024;
const logContext = new WeakMap<ServerResponse, RequestLogContext>();

export function createHttpApp(actor: Actor = actorFromEnv(), store: MemoryStore = createStoreFromEnv()) {
  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      const context = logContext.get(response) ?? {};
      console.error(
        JSON.stringify({
          level: response.statusCode >= 500 ? "error" : "info",
          event: "http_request",
          request_id: requestId,
          method: request.method ?? "GET",
          path: url.pathname,
          status: response.statusCode,
          duration_ms: Date.now() - startedAt,
          actor: context.actor ? `${context.actor.runtime}:${context.actor.agentId}` : undefined,
          agent_id: context.actor?.agentId,
          runtime: context.actor?.runtime,
          tenant: context.tenant,
          project: context.project,
          error: context.error,
        }),
      );
    });

    try {
      await handleRequest(actor, store, request, response);
    } catch (error) {
      setLogContext(response, { error: error instanceof Error ? error.message : String(error) });
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on("close", () => {
    void store.close?.();
  });

  return server;
}

export function listenUrl(server: ReturnType<typeof createServer>) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function handleRequest(
  defaultActor: Actor,
  store: MemoryStore,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    return send(response, 200, { ok: true, backend: process.env.AGENT_MEMORY_BACKEND ?? "fake" });
  }

  const actor = actorForRequest(request, defaultActor);

  if (!actor) {
    setLogContext(response, { error: "unauthorized" });
    await auditHttp(store, response, {
      action: "auth.unauthorized",
      metadata: { method, path: url.pathname },
    });
    return send(response, 401, { error: "unauthorized" });
  }

  if (method === "POST" && url.pathname === "/v1/memory/search") {
    const input = await readJson(request);
    const tenant = stringOrDefault(input.tenant, actor.tenant);
    const project = requiredString(input.project, "project");
    setLogContext(response, { actor, tenant, project });
    if (!canRead(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "memory.search" },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    return send(response, 200, {
      items: await store.memorySearch({
        tenant,
        project,
        query: requiredString(input.query, "query"),
        namespace: optionalString(input.namespace),
        kind: optionalString(input.kind),
        limit: numberOrDefault(input.limit, 5, 1, 20),
        mode: searchMode(input.mode),
        embedding_model: optionalString(input.embedding_model),
        query_embedding: optionalNumberArray(input.query_embedding),
      }),
    });
  }

  const memoryGetMatch = url.pathname.match(/^\/v1\/memory\/([^/]+)$/);
  if (method === "GET" && memoryGetMatch) {
    const tenant = stringOrDefault(url.searchParams.get("tenant"), actor.tenant);
    const project = requiredString(url.searchParams.get("project"), "project");
    setLogContext(response, { actor, tenant, project });
    if (!canRead(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "memory.get" },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    const id = memoryGetMatch[1];
    if (!isUuid(id)) {
      setLogContext(response, { error: "invalid_memory_id" });
      return send(response, 400, { error: "invalid_memory_id" });
    }
    const item = await store.memoryGet({ tenant, project, id });
    return item ? send(response, 200, item) : send(response, 404, { error: "not_found" });
  }

  if (method === "POST" && url.pathname === "/v1/memory") {
    const input = await readJson(request);
    const tenant = stringOrDefault(input.tenant, actor.tenant);
    const project = requiredString(input.project, "project");
    setLogContext(response, { actor, tenant, project });
    if (!canWrite(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "memory.add" },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    const warnings = scanForSecrets(input);
    if (warnings.length) {
      setLogContext(response, { error: warnings.join(",") });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "memory.secret_rejected",
        metadata: { warnings, source_type: optionalString(input.source_type) },
      });
      return send(response, 200, { accepted: false, warnings });
    }
    return send(
      response,
      200,
      await store.memoryAdd(actor, {
        tenant,
        project,
        namespace: stringOrDefault(input.namespace, "ops"),
        kind: requiredString(input.kind, "kind"),
        title: optionalString(input.title),
        body: requiredString(input.body, "body"),
        summary: optionalString(input.summary),
        metadata: objectOrDefault(input.metadata),
        source_type: sourceType(input.source_type),
        source_ref: optionalString(input.source_ref),
        confidence: optionalNumber(input.confidence),
      }),
    );
  }

  if (method === "GET" && url.pathname === "/v1/context") {
    const tenant = stringOrDefault(url.searchParams.get("tenant"), actor.tenant);
    const project = requiredString(url.searchParams.get("project"), "project");
    setLogContext(response, { actor, tenant, project });
    if (!canRead(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "context.get" },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    return send(response, 200, {
      project,
      contexts: await store.contextGet({
        tenant,
        project,
        keys: url.searchParams.getAll("key"),
      }),
    });
  }

  const contextSetMatch = url.pathname.match(/^\/v1\/context\/([^/]+)$/);
  if (method === "PUT" && contextSetMatch) {
    const input = await readJson(request);
    const tenant = stringOrDefault(input.tenant, actor.tenant);
    const project = requiredString(input.project, "project");
    setLogContext(response, { actor, tenant, project });
    if (!canAdmin(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "context.set", key: decodeURIComponent(contextSetMatch[1]) },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    const warnings = scanForSecrets(input);
    if (warnings.length) {
      setLogContext(response, { error: warnings.join(",") });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "context.secret_rejected",
        metadata: { warnings, key: decodeURIComponent(contextSetMatch[1]) },
      });
      return send(response, 200, { accepted: false, warnings });
    }
    return send(
      response,
      200,
      await store.contextSet(actor, {
        tenant,
        project,
        key: decodeURIComponent(contextSetMatch[1]),
        value: input.value,
        source_ref: optionalString(input.source_ref),
        note: optionalString(input.note),
      }),
    );
  }

  if (method === "POST" && url.pathname === "/v1/observations") {
    const input = await readJson(request);
    const tenant = stringOrDefault(input.tenant, actor.tenant);
    const project = requiredString(input.project, "project");
    setLogContext(response, { actor, tenant, project });
    if (!canWrite(actor, tenant, project)) {
      setLogContext(response, { error: "permission_denied" });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "auth.permission_denied",
        metadata: { method, path: url.pathname, operation: "observation.add" },
      });
      return send(response, 403, { error: "permission_denied" });
    }
    const warnings = scanForSecrets(input);
    if (warnings.length) {
      setLogContext(response, { error: warnings.join(",") });
      await auditHttp(store, response, {
        actor,
        tenant,
        project,
        action: "observation.secret_rejected",
        metadata: { warnings },
      });
      return send(response, 200, { accepted: false, warnings });
    }
    return send(
      response,
      200,
      await store.observationAdd(actor, {
        tenant,
        project,
        session_id: optionalString(input.session_id),
        observation: requiredString(input.observation, "observation"),
        metadata: objectOrDefault(input.metadata),
        ttl_days: numberOrDefault(input.ttl_days, 30, 1, 180),
      }),
    );
  }

  setLogContext(response, { actor, error: "not_found" });
  send(response, 404, { error: "not_found" });
}

type RequestLogContext = {
  actor?: Actor;
  tenant?: string;
  project?: string;
  error?: string;
};

function setLogContext(response: ServerResponse, context: RequestLogContext) {
  logContext.set(response, { ...(logContext.get(response) ?? {}), ...context });
}

async function auditHttp(
  store: MemoryStore,
  response: ServerResponse,
  input: {
    actor?: Actor;
    tenant?: string;
    project?: string;
    action: string;
    metadata?: Record<string, unknown>;
  },
) {
  await store.auditEvent({
    tenant: input.tenant ?? input.actor?.tenant,
    actor: input.actor,
    action: input.action,
    target_type: "http_request",
    project: input.project,
    request_id: String(response.getHeader("x-request-id") ?? randomUUID()),
    metadata: input.metadata,
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required string: ${name}`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalNumberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "number")
    ? value
    : undefined;
}

function searchMode(value: unknown): "keyword" | "semantic" | "hybrid" | undefined {
  if (value === undefined) return undefined;
  if (value === "keyword" || value === "semantic" || value === "hybrid") return value;
  throw new Error("Invalid search mode");
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected integer between ${min} and ${max}`);
  }
  return number;
}

function objectOrDefault(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceType(value: unknown) {
  const allowed = new Set(["user", "agent", "file", "command", "url", "system", "manual", "import"]);
  if (typeof value !== "string" || !allowed.has(value)) throw new Error("Invalid source_type");
  return value as any;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function actorForRequest(request: IncomingMessage, fallback: Actor): Actor | undefined {
  const tokens = loadTokenRegistry();
  if (!tokens) {
    return fallback;
  }

  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;
  if (!token) {
    return undefined;
  }

  const registry = JSON.parse(tokens) as Record<string, Partial<Actor>>;
  const actor = registry[token];
  if (!actor?.agentId || !actor.runtime || !actor.role) {
    return undefined;
  }

  return {
    tenant: actor.tenant ?? fallback.tenant,
    agentId: actor.agentId,
    runtime: actor.runtime,
    workspace: actor.workspace ?? fallback.workspace,
    role: actor.role,
    projects: actor.projects?.length ? actor.projects : fallback.projects,
  };
}

function loadTokenRegistry(): string | undefined {
  if (process.env.AGENT_MEMORY_HTTP_TOKENS_JSON) {
    return process.env.AGENT_MEMORY_HTTP_TOKENS_JSON;
  }

  if (process.env.AGENT_MEMORY_HTTP_TOKENS_FILE) {
    return readFileSync(process.env.AGENT_MEMORY_HTTP_TOKENS_FILE, "utf8");
  }

  return undefined;
}
