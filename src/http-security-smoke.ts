import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachGracefulShutdown,
  createHttpApp,
  isLoopbackHost,
  listenUrl,
  resolveHttpAuthFromEnv,
  tokenRegistryKey,
  validateTokenRegistry,
} from "./http.js";
import type { MemoryStore } from "./store.js";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const secretDetail = "super-secret-db-password-hunter2";

async function main() {
  // --- Production entrypoint rejects missing auth before listen ---
  const missingAuthExit = await runHttpServerProcess({
    AGENT_MEMORY_HTTP_HOST: "127.0.0.1",
    AGENT_MEMORY_HTTP_PORT: "0",
    AGENT_MEMORY_BACKEND: "fake",
  });
  assert.notEqual(missingAuthExit.code, 0, "http-server must fail without auth config");
  assert.match(missingAuthExit.stderr, /failed to start|authentication is required/i);

  // --- Startup resolution (no listen) ---
  await assertRejects(
    () => resolveHttpAuthFromEnv({}, "127.0.0.1"),
    /authentication is required|token registry/i,
    "missing config rejection",
  );

  await assertRejects(
    () =>
      resolveHttpAuthFromEnv(
        { AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL: "1" },
        "0.0.0.0",
      ),
    /loopback/i,
    "non-loopback demo rejection",
  );

  await assertRejects(
    () =>
      resolveHttpAuthFromEnv(
        { AGENT_MEMORY_HTTP_TOKENS_JSON: "{not-json" },
        "127.0.0.1",
      ),
    /not valid JSON/i,
    "malformed registry JSON rejection",
  );

  await assertRejects(
    () =>
      resolveHttpAuthFromEnv(
        {
          AGENT_MEMORY_HTTP_TOKENS_JSON: JSON.stringify({
            [tokenRegistryKey("token-without-role")]: {
              agentId: "a",
              runtime: "r",
              projects: ["*"],
            },
          }),
        },
        "127.0.0.1",
      ),
    /invalid role|missing/i,
    "malformed registry actor rejection",
  );

  // Ensure validation errors never echo bearer token material.
  const leakedToken = "leaked-bearer-token-value-xyz";
  try {
    validateTokenRegistry({
      [tokenRegistryKey(leakedToken)]: { agentId: "a", runtime: "r", role: "nope", projects: ["*"] },
    });
    assert.fail("expected invalid role to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.doesNotMatch(message, new RegExp(leakedToken));
    assert.match(message, /entry #1|invalid role/i);
  }

  // Plaintext token keys are rejected outright (hashed-key format only).
  await assertRejects(
    () =>
      validateTokenRegistry({
        "plain-bearer-token-value": { agentId: "a", runtime: "r", role: "reader", projects: ["*"] },
      }),
    /SHA-256 hex digest|migrate-http-tokens/,
    "plaintext registry key rejection",
  );

  await assertRejects(
    () =>
      validateTokenRegistry({
        " not-a-digest ": {
          agentId: "a",
          runtime: "r",
          role: "reader",
          projects: ["*"],
        },
      }),
    /SHA-256 hex digest/i,
    "non-digest bearer token key rejection",
  );

  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);

  const unauth = resolveHttpAuthFromEnv(
    { AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL: "1" },
    "127.0.0.1",
  );
  assert.equal(unauth.mode, "unauthenticated_local");

  // --- Authenticated request path ---
  const tmp = await mkdtemp(join(tmpdir(), "http-security-smoke-"));
  const storePath = join(tmp, "store.json");
  const token = "security-smoke-token-001";
  const registry = {
    [tokenRegistryKey(token)]: {
      agentId: "security-smoke",
      runtime: "smoke",
      role: "writer" as const,
      projects: ["server-ops"],
    },
  };

  const actor: Actor = {
    tenant: "default",
    agentId: "fallback-must-not-authorize",
    runtime: "fallback",
    workspace: process.cwd(),
    role: "admin",
    projects: ["*"],
  };

  const store = new FakeStore(storePath);
  const server = createHttpApp({
    actor,
    store,
    tokenRegistry: registry,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = listenUrl(server);

  try {
    // Open health behavior (no Authorization).
    const health = await requestRaw("GET", `${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    // Unauthorized without bearer.
    const unauthReq = await requestRaw("POST", `${baseUrl}/v1/memory/search`, {
      tenant: "default",
      project: "server-ops",
      query: "x",
    });
    assert.equal(unauthReq.status, 401);
    assert.equal(unauthReq.body.error, "unauthorized");

    // Unauthorized with wrong bearer.
    const badToken = await requestRaw(
      "POST",
      `${baseUrl}/v1/memory/search`,
      { tenant: "default", project: "server-ops", query: "x" },
      "wrong-token",
    );
    assert.equal(badToken.status, 401);
    assert.equal(badToken.body.error, "unauthorized");

    // Authorized write + search.
    const added = await requestRaw(
      "POST",
      `${baseUrl}/v1/memory`,
      {
        tenant: "default",
        project: "server-ops",
        namespace: "ops",
        kind: "note",
        title: "security smoke",
        body: "authorized write",
        source_type: "manual",
      },
      token,
    );
    assert.equal(added.status, 200);
    assert.equal(added.body.accepted, true);

    // Sanitized internal errors: store throws secret detail; client sees internal_error only.
    const throwingStore = {
      memorySearch: async () => {
        throw new Error(secretDetail);
      },
      memoryGet: async () => undefined,
      memoryAdd: async () => {
        throw new Error("unused");
      },
      contextGet: async () => [],
      contextSet: async () => {
        throw new Error("unused");
      },
      observationAdd: async () => {
        throw new Error("unused");
      },
      auditEvent: async () => undefined,
      close: async () => undefined,
    } as unknown as MemoryStore;

    const errorServer = createHttpApp({
      actor,
      store: throwingStore,
      tokenRegistry: registry,
    });
    await new Promise<void>((resolveListen) => errorServer.listen(0, "127.0.0.1", resolveListen));
    const errorBase = listenUrl(errorServer);
    try {
      const failed = await requestRaw(
        "POST",
        `${errorBase}/v1/memory/search`,
        { tenant: "default", project: "server-ops", query: "x" },
        token,
      );
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error, "internal_error");
      assert.equal(typeof failed.body.request_id, "string");
      assert.ok(failed.body.request_id.length > 0);
      const serialized = JSON.stringify(failed.body);
      assert.doesNotMatch(serialized, new RegExp(secretDetail));
      assert.doesNotMatch(serialized, /hunter2/);
    } finally {
      await new Promise<void>((resolveClose) => errorServer.close(() => resolveClose()));
    }

    // File-based registry startup path.
    const tokenFile = join(tmp, "tokens.json");
    await writeFile(tokenFile, JSON.stringify(registry), "utf8");
    const fileAuth = resolveHttpAuthFromEnv(
      { AGENT_MEMORY_HTTP_TOKENS_FILE: tokenFile },
      "127.0.0.1",
    );
    assert.equal(fileAuth.mode, "token_registry");
    if (fileAuth.mode === "token_registry") {
      assert.ok(fileAuth.registry[tokenRegistryKey(token)]);
    }

    // Graceful shutdown helper closes the listener (SIGINT/SIGTERM path).
    let shutdownStoreClosed = false;
    const shutdownStore = {
      close: async () => {
        shutdownStoreClosed = true;
      },
    } as unknown as MemoryStore;
    const shutdownServer = createHttpApp({
      actor,
      store: shutdownStore,
      tokenRegistry: registry,
    });
    await new Promise<void>((resolveListen) => shutdownServer.listen(0, "127.0.0.1", resolveListen));
    const detach = attachGracefulShutdown(shutdownServer);
    await new Promise<void>((resolveClose, rejectClose) => {
      const timeout = setTimeout(
        () => rejectClose(new Error("SIGTERM shutdown did not close the listener")),
        5_000,
      );
      shutdownServer.once("close", () => {
        clearTimeout(timeout);
        resolveClose();
      });
      process.emit("SIGTERM", "SIGTERM");
    });
    detach();
    assert.equal(shutdownStoreClosed, true, "SIGTERM shutdown must close the store");

    console.log("http security smoke ok");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runHttpServerProcess(
  env: Record<string, string>,
): Promise<{ code: number | null; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("AGENT_MEMORY_")) delete childEnv[key];
    }
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/http-server.ts"],
      {
        cwd: process.cwd(),
        env: { ...childEnv, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`http-server process timed out: ${stderr}`));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function assertRejects(
  fn: () => unknown,
  pattern: RegExp,
  label: string,
): Promise<void> {
  try {
    await fn();
    assert.fail(`${label}: expected rejection`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern, `${label}: ${message}`);
  }
}

async function requestRaw(
  method: string,
  url: string,
  body?: unknown,
  bearer?: string,
): Promise<{ status: number; body: any; accepted?: boolean }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const response = await fetch(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
  });
  const json = await response.json();
  return { status: response.status, body: json, accepted: json?.accepted };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
