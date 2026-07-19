import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpApp, listenUrl } from "./http.js";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const fallback: Actor = {
  tenant: "default",
  agentId: "fallback",
  runtime: "test",
  workspace: "/tmp",
  role: "admin",
  projects: ["*"],
};

test("HTTP authentication, authorization, isolation, and input validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-memory-http-test-"));
  const server = createHttpApp({
    actor: fallback,
    store: new FakeStore(join(directory, "store.json")),
    tokenRegistry: {
      writer: {
        agentId: "writer",
        runtime: "test",
        role: "writer",
        projects: ["project-a"],
      },
      reader: {
        agentId: "reader",
        runtime: "test",
        role: "reader",
        projects: ["project-a"],
      },
    },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = listenUrl(server);

  try {
    const unauthenticated = await request("POST", `${baseUrl}/v1/memory/search`, {
      project: "project-a",
      query: "test",
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body.error, "unauthorized");

    const forbiddenProject = await request(
      "POST",
      `${baseUrl}/v1/memory`,
      memory("project-b"),
      "writer",
    );
    assert.equal(forbiddenProject.status, 403);
    assert.equal(forbiddenProject.body.error, "permission_denied");

    const added = await request("POST", `${baseUrl}/v1/memory`, memory("project-a"), "writer");
    assert.equal(added.status, 200);
    assert.equal(added.body.accepted, true);

    const readerWrite = await request("POST", `${baseUrl}/v1/memory`, memory("project-a"), "reader");
    assert.equal(readerWrite.status, 403);

    const malformed = await requestRaw("POST", `${baseUrl}/v1/memory/search`, "{", "writer");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "invalid_json");

    const invalidMode = await request(
      "POST",
      `${baseUrl}/v1/memory/search`,
      { project: "project-a", query: "sidecar", mode: "unknown" },
      "writer",
    );
    assert.equal(invalidMode.status, 400);
    assert.equal(invalidMode.body.error, "invalid_search_mode");

    const tooLarge = await requestRaw(
      "POST",
      `${baseUrl}/v1/memory/search`,
      JSON.stringify({ project: "project-a", query: "x", padding: "x".repeat(256 * 1024) }),
      "writer",
    );
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error, "request_body_too_large");
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});

function memory(project: string) {
  return {
    project,
    namespace: "ops",
    kind: "note",
    body: "Sidecar integration test memory.",
    source_type: "manual",
  };
}

async function request(method: string, url: string, body: unknown, token?: string) {
  return requestRaw(method, url, JSON.stringify(body), token);
}

async function requestRaw(method: string, url: string, body: string, token?: string) {
  const response = await fetch(url, {
    method,
    body,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return { status: response.status, body: await response.json() };
}
