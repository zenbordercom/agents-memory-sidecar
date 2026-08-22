import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpApp, listenUrl, tokenRegistryKey } from "./http.js";
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
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

// Contract pinning for review finding #13: the MCP and HTTP entry points must
// enforce identical field-level rules. Both import the same schema objects
// from src/schemas.ts; these tests lock the boundaries themselves plus a set
// of HTTP end-to-end spot checks so a future regression cannot silently
// diverge one transport from the other.

test("shared field schemas enforce identical bounds for both entry points", () => {
  // Memory body: 1..64_000 chars.
  assert.equal(memoryBodySchema.safeParse("x").success, true);
  assert.equal(memoryBodySchema.safeParse("x".repeat(64_000)).success, true);
  assert.equal(memoryBodySchema.safeParse("x".repeat(64_001)).success, false);
  assert.equal(memoryBodySchema.safeParse("").success, false);

  // Summary: 1..4_000 chars when present.
  assert.equal(memorySummarySchema.safeParse("s".repeat(4_000)).success, true);
  assert.equal(memorySummarySchema.safeParse("s".repeat(4_001)).success, false);

  // Observation: 1..32_000 chars.
  assert.equal(observationTextSchema.safeParse("o".repeat(32_000)).success, true);
  assert.equal(observationTextSchema.safeParse("o".repeat(32_001)).success, false);

  // Confidence: finite number in [0, 1].
  for (const value of [0, 1, 0.5]) {
    assert.equal(confidenceSchema.safeParse(value).success, true, `confidence ${value}`);
  }
  for (const value of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY, "high"]) {
    assert.equal(confidenceSchema.safeParse(value).success, false, `confidence ${value}`);
  }

  // Search limit: integer 1..20.
  for (const value of [1, 20]) {
    assert.equal(searchLimitSchema.safeParse(value).success, true, `limit ${value}`);
  }
  for (const value of [0, 21, 2.5, Number.NaN, "5"]) {
    assert.equal(searchLimitSchema.safeParse(value).success, false, `limit ${value}`);
  }

  // TTL days: integer 1..180.
  assert.equal(ttlDaysSchema.safeParse(1).success, true);
  assert.equal(ttlDaysSchema.safeParse(180).success, true);
  assert.equal(ttlDaysSchema.safeParse(0).success, false);
  assert.equal(ttlDaysSchema.safeParse(181).success, false);

  // Enums are closed sets on both transports.
  assert.equal(searchModeSchema.safeParse("hybrid").success, true);
  assert.equal(searchModeSchema.safeParse("fuzzy").success, false);
  assert.equal(sourceTypeSchema.safeParse("manual").success, true);
  assert.equal(sourceTypeSchema.safeParse("whisper").success, false);

  // Embedding vectors reject non-finite numbers and empty arrays.
  assert.equal(embeddingVectorSchema.safeParse([0.1, -0.2]).success, true);
  assert.equal(embeddingVectorSchema.safeParse([]).success, false);
  assert.equal(embeddingVectorSchema.safeParse([Number.NaN]).success, false);
  assert.equal(embeddingVectorSchema.safeParse([Number.POSITIVE_INFINITY]).success, false);
});

test("HTTP rejects payloads that violate the shared contract", async () => {
  const fallback: Actor = {
    tenant: "default",
    agentId: "fallback",
    runtime: "contract-test",
    workspace: "/tmp",
    role: "admin",
    projects: ["*"],
  };
  const token = "contract-test-token";
  const directory = await mkdtemp(join(tmpdir(), "agents-memory-contract-"));
  const server = createHttpApp({
    actor: fallback,
    store: new FakeStore(join(directory, "store.json")),
    tokenRegistry: {
      [tokenRegistryKey(token)]: {
        tenant: "default",
        agentId: "writer",
        runtime: "contract-test",
        role: "admin",
        projects: ["*"],
      },
    },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const baseUrl = listenUrl(server);

  async function post(path: string, payload: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    return { status: response.status, body };
  }

  try {
    const base = { tenant: "default", project: "p", namespace: "ops", kind: "note", source_type: "manual" };

    // Oversized body -> rejected with the shared invalid_request code.
    const tooBig = await post("/v1/memory", { ...base, body: "x".repeat(64_001) });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error, "invalid_request");

    // Confidence out of range / non-finite / wrong type -> all rejected.
    for (const confidence of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "high"]) {
      const result = await post("/v1/memory", { ...base, body: "ok", confidence });
      assert.equal(result.status, 400, `confidence ${confidence} must be rejected`);
      assert.equal(result.body.error, "invalid_request");
    }

    // Oversized observation -> rejected.
    const bigObservation = await post("/v1/observations", {
      tenant: "default",
      project: "p",
      observation: "o".repeat(32_001),
      ttl_days: 7,
    });
    assert.equal(bigObservation.status, 400);

    // Out-of-range ttl and non-finite embedding vector -> rejected.
    assert.equal((await post("/v1/observations", { tenant: "default", project: "p", observation: "ok", ttl_days: 0 })).status, 400);
    const badEmbedding = await post("/v1/memory/search", {
      tenant: "default",
      project: "p",
      query: "q",
      mode: "semantic",
      embedding_model: "m",
      query_embedding: [Number.NaN],
    });
    assert.equal(badEmbedding.status, 400);

    // Boundary values at the exact limits are accepted end-to-end.
    const edge = await post("/v1/memory", { ...base, body: "x".repeat(64_000), confidence: 1 });
    assert.equal(edge.status, 200);
    assert.equal(edge.body.accepted, true);

    const search = await post("/v1/memory/search", { tenant: "default", project: "p", query: "x", limit: 20 });
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.body.items));
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(directory, { recursive: true, force: true });
  }
});
