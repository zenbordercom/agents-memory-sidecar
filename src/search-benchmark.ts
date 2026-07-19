import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPgPool } from "./db.js";
import { PgStore } from "./pg-store.js";
import { FakeStore, type MemoryStore } from "./store.js";
import type { Actor } from "./types.js";

type Fixture = {
  version: number;
  embedding_model: string;
  memories: Array<{
    key: string;
    namespace: string;
    kind: string;
    title: string;
    body: string;
    embedding: number[];
  }>;
  queries: Array<{ key: string; query: string; embedding: number[]; relevant: string[] }>;
};

const args = parseArgs(process.argv.slice(2));
const fixturePath = resolve(args.fixture ?? "fixtures/search-relevance.v1.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
const backend = process.env.AGENT_MEMORY_BACKEND === "postgres" ? "postgres" : "fake";
const project = `benchmark-${randomUUID()}`;
const actor: Actor = {
  tenant: "benchmark",
  agentId: "search-benchmark",
  runtime: "benchmark",
  workspace: process.cwd(),
  role: "admin",
  projects: [project],
};

let pool: ReturnType<typeof createPgPool> | undefined;
let store: MemoryStore;
let fakeStorePath: string | undefined;
if (backend === "postgres") {
  pool = createPgPool();
  store = new PgStore(pool);
} else {
  fakeStorePath = join(tmpdir(), `agents-memory-benchmark-${randomUUID()}.json`);
  store = new FakeStore(fakeStorePath);
}

try {
  const report = await benchmark();
  console.log(JSON.stringify(report, null, args.pretty === "true" ? 2 : 0));
} finally {
  await cleanup();
}

async function benchmark() {
  if (fixture.version !== 1) throw new Error(`Unsupported fixture version: ${fixture.version}`);
  const ids = new Map<string, string>();
  for (const memory of fixture.memories) {
    const added = await store.memoryAdd(actor, {
      tenant: actor.tenant,
      project,
      namespace: memory.namespace,
      kind: memory.kind,
      title: memory.title,
      body: memory.body,
      source_type: "manual",
      source_ref: `fixture:${fixture.version}:${memory.key}`,
    });
    if (!added.accepted) throw new Error(`Fixture memory was unexpectedly rejected: ${memory.key}`);
    ids.set(memory.key, added.id);
    if (pool) {
      await pool.query(
        `INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
         SELECT id, $2, $3::vector, content_hash FROM memory_items WHERE id = $1`,
        [added.id, fixture.embedding_model, vectorLiteral(memory.embedding)],
      );
    }
  }

  const modes = backend === "postgres" ? ["keyword", "semantic", "hybrid"] as const : ["keyword"] as const;
  const measurements = [];
  for (const mode of modes) {
    for (const query of fixture.queries) {
      const started = process.hrtime.bigint();
      const items = await store.memorySearch({
        tenant: actor.tenant,
        project,
        query: query.query,
        limit: 5,
        mode,
        embedding_model: mode === "keyword" ? undefined : fixture.embedding_model,
        query_embedding: mode === "keyword" ? undefined : query.embedding,
      }) as Array<{ id: string; search_mode?: string; embedding_model?: string }>;
      const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const expected = new Set(query.relevant.map((key) => ids.get(key)));
      const positions = items.map((item) => item.id).map((id, index) => expected.has(id) ? index + 1 : -1).filter((position) => position > 0);
      measurements.push({
        mode,
        query: query.key,
        latency_ms: Number(latencyMs.toFixed(3)),
        result_count: items.length,
        recall_at_5: expected.size === 0 ? 1 : Number((positions.length / expected.size).toFixed(3)),
        reciprocal_rank: positions.length ? Number((1 / positions[0]).toFixed(3)) : 0,
        actual_mode: items[0]?.search_mode ?? (backend === "fake" ? "keyword" : mode),
        embedding_model: items[0]?.embedding_model ?? null,
        fallback: mode !== "keyword" && items[0]?.search_mode === "keyword",
      });
    }
  }

  const fallback = await fallbackMeasurement();
  return {
    fixture_version: fixture.version,
    backend,
    embedding_model: backend === "postgres" ? fixture.embedding_model : null,
    dimensions: backend === "postgres" ? fixture.memories[0]?.embedding.length ?? null : null,
    project_scope: "ephemeral",
    measurements,
    fallback,
    note: "Fixture relevance is a deterministic regression signal, not a statistical quality claim.",
  };
}

async function fallbackMeasurement() {
  const query = fixture.queries[0];
  if (backend === "fake") {
    return { requested_mode: "hybrid", actual_mode: "keyword", fallback: true, reason: "fake_backend" };
  }
  const previous = process.env.AGENT_MEMORY_EMBEDDING_MODEL;
  delete process.env.AGENT_MEMORY_EMBEDDING_MODEL;
  try {
    const items = await store.memorySearch({
      tenant: actor.tenant,
      project,
      query: query.query,
      limit: 5,
      mode: "hybrid",
    }) as Array<{ search_mode?: string }>;
    return {
      requested_mode: "hybrid",
      actual_mode: items[0]?.search_mode ?? "keyword",
      fallback: items[0]?.search_mode === "keyword",
      reason: "embedding_not_configured",
    };
  } finally {
    if (previous === undefined) delete process.env.AGENT_MEMORY_EMBEDDING_MODEL;
    else process.env.AGENT_MEMORY_EMBEDDING_MODEL = previous;
  }
}

async function cleanup() {
  if (pool) {
    const params = [actor.tenant, project];
    await pool.query(
      `DELETE FROM memory_embeddings me USING memory_items mi
       WHERE me.memory_id = mi.id AND mi.tenant = $1 AND mi.project = $2`,
      params,
    );
    await pool.query("DELETE FROM audit_events WHERE tenant = $1 AND project = $2", params);
    await pool.query("DELETE FROM memory_items WHERE tenant = $1 AND project = $2", params);
  }
  await store.close?.();
  if (fakeStorePath) await rm(fakeStorePath, { force: true });
}

function vectorLiteral(values: number[]): string {
  if (!values.length || !values.every(Number.isFinite)) throw new Error("Fixture embedding must contain finite values");
  return `[${values.join(",")}]`;
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}
