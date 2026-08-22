import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { actorFromEnv, canAdmin, canRead, canWrite } from "./actor.js";
import {
  confidenceSchema,
  embeddingVectorSchema,
  memoryBodySchema,
  memorySummarySchema,
  observationTextSchema,
  searchLimitSchema,
  searchModeSchema,
  sourceTypeSchema,
  ttlDaysSchema,
} from "./schemas.js";
import { z } from "zod";
import { scanForSecrets } from "./security.js";
import { createStoreFromEnv } from "./store-factory.js";
import type { Actor, Role } from "./types.js";
import type { MemoryStore } from "./store.js";

const maxBodyBytes = 256 * 1024;
const logContext = new WeakMap<ServerResponse, RequestLogContext>();
const storeCloseHooks = new WeakMap<Server, () => Promise<void>>();
const validRoles = new Set<Role>(["reader", "writer", "admin"]);

export type TokenRegistryEntry = {
  tenant?: string;
  agentId: string;
  runtime: string;
  workspace?: string;
  role: Role;
  projects: string[];
};

/**
 * Maps SHA-256 hex digests of bearer tokens (the canonical key form produced
 * by {@link tokenRegistryKey}) to their actor records. Plaintext tokens are
 * never stored; see validateTokenRegistry for the enforced key format.
 */
export type TokenRegistry = Record<string, TokenRegistryEntry>;

export type HttpAuthState =
  | { mode: "token_registry"; registry: TokenRegistry; fallback: Actor }
  | { mode: "unauthenticated_local"; fallback: Actor };

export type CreateHttpAppOptions = {
  actor?: Actor;
  store?: MemoryStore;
  /** Fully resolved auth state. When omitted, resolved from env (or test opt-in). */
  auth?: HttpAuthState;
  /** Bind host used when resolving env auth (unauthenticated mode must be loopback). */
  host?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Test-only: allow requests without a token registry using the provided actor.
   * Production `agents-memory-http` never sets this flag.
   */
  allowUnauthenticatedForTests?: boolean;
  /** Test-only injected registry (skips env file/json load). */
  tokenRegistry?: TokenRegistry;
};

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "[::1]"
  );
}

/**
 * Resolve HTTP authentication before the server listens.
 * Fails closed unless a valid token registry is configured, or explicit
 * unauthenticated loopback demo mode is enabled.
 */
export function resolveHttpAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  host = env.AGENT_MEMORY_HTTP_HOST ?? "127.0.0.1",
): HttpAuthState {
  const fallback = actorFromEnv(env);
  const hasJson = Boolean(env.AGENT_MEMORY_HTTP_TOKENS_JSON?.trim());
  const hasFile = Boolean(env.AGENT_MEMORY_HTTP_TOKENS_FILE?.trim());

  if (hasJson || hasFile) {
    const registry = loadAndValidateTokenRegistry(env);
    return { mode: "token_registry", registry, fallback };
  }

  if (env.AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL === "1") {
    if (!isLoopbackHost(host)) {
      throw new Error(
        "AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1 requires a loopback bind host " +
          "(127.0.0.1, ::1, or localhost). " +
          `Refusing to start with AGENT_MEMORY_HTTP_HOST=${host}`,
      );
    }
    return { mode: "unauthenticated_local", fallback };
  }

  throw new Error(
    "HTTP sidecar authentication is required. Set AGENT_MEMORY_HTTP_TOKENS_FILE or " +
      "AGENT_MEMORY_HTTP_TOKENS_JSON to a valid token registry, or set " +
      "AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1 only for deliberate loopback demos/tests.",
  );
}

export function createHttpApp(
  actorOrOptions?: Actor | CreateHttpAppOptions,
  storeArg?: MemoryStore,
): Server {
  const options = normalizeCreateOptions(actorOrOptions, storeArg);
  const store = options.store ?? createStoreFromEnv();
  const fallbackActor = options.actor ?? actorFromEnv(options.env ?? process.env);
  const auth = resolveCreateAuth(options, fallbackActor);

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
      await handleRequest(auth, store, request, response);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        setLogContext(response, { error: error.code });
        return send(response, error.status, { error: error.code });
      }
      const detail = error instanceof Error ? error.message : String(error);
      setLogContext(response, { error: detail });
      console.error(
        JSON.stringify({
          level: "error",
          event: "http_internal_error",
          request_id: requestId,
          method: request.method ?? "GET",
          path: url.pathname,
          error: detail,
        }),
      );
      send(response, 500, { error: "internal_error", request_id: requestId });
    }
  });

  let storeClosePromise: Promise<void> | undefined;
  const closeStoreOnce = (): Promise<void> => {
    if (!storeClosePromise) {
      storeClosePromise = Promise.resolve(store.close?.());
    }
    return storeClosePromise;
  };

  server.on("close", () => {
    void closeStoreOnce().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "http_store_close_error",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  storeCloseHooks.set(server, closeStoreOnce);

  return server;
}

/** Attach SIGINT/SIGTERM handlers that stop the listener and close the store once. */
export function attachGracefulShutdown(server: Server, store?: MemoryStore): () => void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(
      JSON.stringify({
        level: "info",
        event: "http_shutdown",
        signal,
      }),
    );
    server.close(async (error) => {
      if (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "http_shutdown_error",
            error: error.message,
          }),
        );
        process.exitCode = 1;
      }
      try {
        await (storeCloseHooks.get(server)?.() ?? Promise.resolve(store?.close?.()));
      } catch (closeError) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "http_store_close_error",
            error: closeError instanceof Error ? closeError.message : String(closeError),
          }),
        );
        process.exitCode = 1;
      }
      // Allow the process to exit naturally once the event loop drains.
    });
  };

  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

export function listenUrl(server: ReturnType<typeof createServer>) {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function normalizeCreateOptions(
  actorOrOptions?: Actor | CreateHttpAppOptions,
  storeArg?: MemoryStore,
): CreateHttpAppOptions {
  if (!actorOrOptions) {
    return storeArg ? { store: storeArg } : {};
  }

  if (isActor(actorOrOptions)) {
    return { actor: actorOrOptions, store: storeArg };
  }

  if (storeArg) {
    return { ...actorOrOptions, store: actorOrOptions.store ?? storeArg };
  }

  return actorOrOptions;
}

function isActor(value: Actor | CreateHttpAppOptions): value is Actor {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    "runtime" in value &&
    "role" in value &&
    "projects" in value &&
    !("allowUnauthenticatedForTests" in value) &&
    !("tokenRegistry" in value) &&
    !("auth" in value) &&
    !("store" in value) &&
    !("host" in value) &&
    !("env" in value)
  );
}

function resolveCreateAuth(options: CreateHttpAppOptions, fallbackActor: Actor): HttpAuthState {
  if (options.auth) {
    return options.auth;
  }

  if (options.tokenRegistry) {
    validateTokenRegistry(options.tokenRegistry);
    return { mode: "token_registry", registry: options.tokenRegistry, fallback: fallbackActor };
  }

  if (options.allowUnauthenticatedForTests) {
    return { mode: "unauthenticated_local", fallback: fallbackActor };
  }

  return resolveHttpAuthFromEnv(options.env ?? process.env, options.host ?? "127.0.0.1");
}

function loadAndValidateTokenRegistry(env: NodeJS.ProcessEnv): TokenRegistry {
  let raw: string;
  let source: "AGENT_MEMORY_HTTP_TOKENS_JSON" | "AGENT_MEMORY_HTTP_TOKENS_FILE";

  if (env.AGENT_MEMORY_HTTP_TOKENS_JSON?.trim()) {
    raw = env.AGENT_MEMORY_HTTP_TOKENS_JSON;
    source = "AGENT_MEMORY_HTTP_TOKENS_JSON";
  } else if (env.AGENT_MEMORY_HTTP_TOKENS_FILE?.trim()) {
    source = "AGENT_MEMORY_HTTP_TOKENS_FILE";
    try {
      raw = readFileSync(env.AGENT_MEMORY_HTTP_TOKENS_FILE, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to read AGENT_MEMORY_HTTP_TOKENS_FILE (${env.AGENT_MEMORY_HTTP_TOKENS_FILE}): ${detail}`,
      );
    }
  } else {
    throw new Error("Token registry is not configured");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} is not valid JSON. Provide an object mapping bearer tokens to actor records.`);
  }

  return validateTokenRegistry(parsed, source);
}

const tokenDigestPattern = /^[0-9a-f]{64}$/;

/**
 * Canonical registry key for a bearer token: the lowercase hex SHA-256 digest
 * of the UTF-8 token bytes. Scripts and tests must store keys in this form.
 */
export function tokenRegistryKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function validateTokenRegistry(parsed: unknown, source = "token registry"): TokenRegistry {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object mapping bearer-token digests to actor records.`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${source} must contain at least one bearer token entry.`);
  }

  const registry: TokenRegistry = {};
  let index = 0;
  for (const [tokenDigest, value] of entries) {
    index += 1;
    const label = `entry #${index}`;

    if (typeof tokenDigest !== "string" || tokenDigest.trim().length === 0) {
      throw new Error(`${source} ${label} has an empty bearer token key.`);
    }
    if (!tokenDigestPattern.test(tokenDigest.toLowerCase())) {
      throw new Error(
        `${source} ${label} key must be the SHA-256 hex digest of the bearer token (64 hex characters); `
          + `plaintext tokens are not accepted. Generate keys with scripts/upsert-http-token.mjs, `
          + `or convert an existing plaintext file with scripts/migrate-http-tokens.mjs.`,
      );
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${source} ${label} must be an object with agentId, runtime, role, and projects.`);
    }

    const record = value as Record<string, unknown>;
    const agentId = record.agentId;
    const runtime = record.runtime;
    const role = record.role;
    const projects = record.projects;

    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      throw new Error(`${source} ${label} is missing a non-empty string agentId.`);
    }
    if (typeof runtime !== "string" || runtime.trim().length === 0) {
      throw new Error(
        `${source} ${label} (agentId=${agentId}) is missing a non-empty string runtime.`,
      );
    }
    if (typeof role !== "string" || !validRoles.has(role as Role)) {
      throw new Error(
        `${source} ${label} (agentId=${agentId}) has invalid role; expected reader|writer|admin.`,
      );
    }
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error(
        `${source} ${label} (agentId=${agentId}) requires a non-empty projects array.`,
      );
    }
    if (!projects.every((project) => typeof project === "string" && project.trim().length > 0)) {
      throw new Error(
        `${source} ${label} (agentId=${agentId}) has invalid projects; every entry must be a non-empty string.`,
      );
    }

    const tenant = record.tenant;
    const workspace = record.workspace;
    if (tenant !== undefined && (typeof tenant !== "string" || tenant.trim().length === 0)) {
      throw new Error(`${source} ${label} (agentId=${agentId}) has invalid tenant.`);
    }
    if (
      workspace !== undefined &&
      (typeof workspace !== "string" || workspace.trim().length === 0)
    ) {
      throw new Error(`${source} ${label} (agentId=${agentId}) has invalid workspace.`);
    }

    registry[tokenDigest.toLowerCase()] = {
      tenant: typeof tenant === "string" ? tenant : undefined,
      agentId,
      runtime,
      workspace: typeof workspace === "string" ? workspace : undefined,
      role: role as Role,
      projects: projects as string[],
    };
  }

  return registry;
}


async function authorize(
  store: MemoryStore,
  response: ServerResponse,
  input: {
    actor: Actor;
    tenant: string;
    project: string;
    role: "read" | "write" | "admin";
    operation: string;
    method: string;
    path: string;
    /** Extra audit metadata (e.g. the context key) appended to denial records. */
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { actor, tenant, project } = input;
  const allowed =
    input.role === "read"
      ? canRead(actor, tenant, project)
      : input.role === "write"
        ? canWrite(actor, tenant, project)
        : canAdmin(actor, tenant, project);
  if (allowed) return;

  setLogContext(response, { error: "permission_denied" });
  await auditHttp(store, response, {
    actor,
    tenant,
    project,
    action: "auth.permission_denied",
    metadata: { method: input.method, path: input.path, operation: input.operation, ...input.metadata },
  });
  throw new HttpRequestError(403, "permission_denied");
}

async function handleRequest(
  auth: HttpAuthState,
  store: MemoryStore,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  // /healthz remains unauthenticated for local liveness checks.
  if (method === "GET" && url.pathname === "/healthz") {
    return send(response, 200, { ok: true, backend: process.env.AGENT_MEMORY_BACKEND ?? "fake" });
  }

  const actor = actorForRequest(request, auth);

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
    await authorize(store, response, { actor, tenant, project, role: "read", operation: "memory.search", method, path: url.pathname });
    return send(response, 200, {
      items: await store.memorySearch({
        tenant,
        project,
        query: requiredString(input.query, "query"),
        namespace: optionalString(input.namespace),
        kind: optionalString(input.kind),
        limit: parseField(searchLimitSchema, input.limit, { fallback: 5 }),
        mode: searchMode(input.mode),
        embedding_model: optionalString(input.embedding_model),
        query_embedding: optionalField(input.query_embedding, embeddingVectorSchema),
      }),
    });
  }

  const memoryGetMatch = url.pathname.match(/^\/v1\/memory\/([^/]+)$/);
  if (method === "GET" && memoryGetMatch) {
    const tenant = stringOrDefault(url.searchParams.get("tenant"), actor.tenant);
    const project = requiredString(url.searchParams.get("project"), "project");
    setLogContext(response, { actor, tenant, project });
    await authorize(store, response, { actor, tenant, project, role: "read", operation: "memory.get", method, path: url.pathname });
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
    await authorize(store, response, { actor, tenant, project, role: "write", operation: "memory.add", method, path: url.pathname });
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
        body: parseField(memoryBodySchema, input.body),
        summary: optionalField(input.summary, memorySummarySchema),
        metadata: objectOrDefault(input.metadata),
        source_type: parseField(sourceTypeSchema, input.source_type),
        source_ref: optionalString(input.source_ref),
        confidence: optionalField(input.confidence, confidenceSchema),
      }),
    );
  }

  if (method === "GET" && url.pathname === "/v1/context") {
    const tenant = stringOrDefault(url.searchParams.get("tenant"), actor.tenant);
    const project = requiredString(url.searchParams.get("project"), "project");
    setLogContext(response, { actor, tenant, project });
    await authorize(store, response, { actor, tenant, project, role: "read", operation: "context.get", method, path: url.pathname });
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
    await authorize(store, response, {
      actor,
      tenant,
      project,
      role: "admin",
      operation: "context.set",
      method,
      path: url.pathname,
      metadata: { key: decodeURIComponent(contextSetMatch[1]) },
    });
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
    await authorize(store, response, { actor, tenant, project, role: "write", operation: "observation.add", method, path: url.pathname });
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
        observation: parseField(observationTextSchema, input.observation),
        metadata: objectOrDefault(input.metadata),
        ttl_days: parseField(ttlDaysSchema, input.ttl_days, { fallback: 30 }),
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

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

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
      throw new HttpRequestError(413, "request_body_too_large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpRequestError(400, "invalid_json");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    throw new HttpRequestError(400, "invalid_json");
  }
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpRequestError(400, "invalid_request");
  }
  return value;
}

// Validate one field against the shared contract; both entry points must
// enforce identical rules, so HTTP never hand-rolls a constraint that exists
// in src/schemas.ts.
function parseField<T>(schema: z.ZodType<T>, value: unknown, options?: { fallback?: T; errorCode?: string }): T {
  if (value === undefined && options?.fallback !== undefined) return options.fallback;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpRequestError(400, options?.errorCode ?? "invalid_request");
  }
  return result.data;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalField<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  return value === undefined ? undefined : parseField(schema, value);
}

function searchMode(value: unknown): "keyword" | "semantic" | "hybrid" | undefined {
  // Keep the historical, more specific error code for this field.
  return value === undefined
    ? undefined
    : parseField(searchModeSchema, value, { errorCode: "invalid_search_mode" });
}

function objectOrDefault(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function actorForRequest(request: IncomingMessage, auth: HttpAuthState): Actor | undefined {
  if (auth.mode === "unauthenticated_local") {
    return auth.fallback;
  }

  const header = request.headers.authorization;
  const token =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : undefined;
  if (!token) {
    return undefined;
  }

  // Hash the presented token and compare against every stored digest with
  // timingSafeEqual over fixed-length buffers - object property lookup is NOT
  // constant-time, so an explicit comparison is required for the guarantee.
  const providedDigest = createHash("sha256").update(token, "utf8").digest();
  for (const [key, entry] of Object.entries(auth.registry)) {
    const expectedDigest = Buffer.from(key, "hex");
    if (expectedDigest.length === providedDigest.length && timingSafeEqual(expectedDigest, providedDigest)) {
      return {
        tenant: entry.tenant ?? auth.fallback.tenant,
        agentId: entry.agentId,
        runtime: entry.runtime,
        workspace: entry.workspace ?? auth.fallback.workspace,
        role: entry.role,
        projects: entry.projects,
      };
    }
  }
  return undefined;
}
