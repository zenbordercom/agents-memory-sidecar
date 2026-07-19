import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHttpApp, listenUrl } from "./http.js";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const storePath = resolve("data/http-smoke-store.json");

async function main() {
  await rm(storePath, { force: true });

  const actor: Actor = {
    tenant: "default",
    agentId: "http-smoke-admin",
    runtime: "http-smoke",
    workspace: process.cwd(),
    role: "admin",
    projects: ["*"],
  };

  // Test-only unauthenticated mode: production agents-memory-http never sets this.
  const server = createHttpApp({
    actor,
    store: new FakeStore(storePath),
    allowUnauthenticatedForTests: true,
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = listenUrl(server);

  try {
    const health = await request("GET", `${baseUrl}/healthz`);
    assert.equal(health.ok, true);

    const contextSet = await request("PUT", `${baseUrl}/v1/context/deployment`, {
      tenant: "default",
      project: "server-ops",
      value: { manager: "systemd" },
      source_ref: "manual:http-smoke",
    });
    assert.equal(contextSet.accepted, true);

    const contextGet = await request("GET", `${baseUrl}/v1/context?tenant=default&project=server-ops&key=deployment`);
    assert.equal(contextGet.contexts.length, 1);

    const added = await request("POST", `${baseUrl}/v1/memory`, {
      tenant: "default",
      project: "server-ops",
      namespace: "incident",
      kind: "incident",
      title: "HTTP smoke memory",
      body: "HTTP sidecar smoke test wrote and searched this memory.",
      source_type: "manual",
    });
    assert.equal(added.accepted, true);

    const search = await request("POST", `${baseUrl}/v1/memory/search`, {
      tenant: "default",
      project: "server-ops",
      query: "HTTP smoke",
    });
    assert.equal(search.items.length, 1);

    const full = await request("GET", `${baseUrl}/v1/memory/${search.items[0].id}?tenant=default&project=server-ops`);
    assert.equal(full.title, "HTTP smoke memory");

    const invalidMemoryGet = await requestRaw(
      "GET",
      `${baseUrl}/v1/memory/not-a-uuid?tenant=default&project=server-ops`,
    );
    assert.equal(invalidMemoryGet.status, 400);
    assert.equal(invalidMemoryGet.body.error, "invalid_memory_id");

    const observation = await request("POST", `${baseUrl}/v1/observations`, {
      tenant: "default",
      project: "server-ops",
      observation: "HTTP smoke observation",
      ttl_days: 7,
    });
    assert.equal(observation.accepted, true);

    console.log("http smoke ok");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
}

async function request(method: string, url: string, body?: unknown): Promise<any> {
  const result = await requestRaw(method, url, body);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${url} failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function requestRaw(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
