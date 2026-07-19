import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createPgPool } from "./db.js";
import { PgStore } from "./pg-store.js";
import type { Actor } from "./types.js";

const actor: Actor = {
  tenant: "default",
  agentId: "postgres-smoke",
  runtime: "test",
  role: "admin",
  projects: ["*"],
};

const pool = createPgPool();
const store = new PgStore(pool);
const project = `postgres-smoke-${randomUUID()}`;

async function main() {
  try {
    const migrations = await pool.query(
      "SELECT name FROM schema_migrations WHERE name IN ('001_initial.sql', '002_observation_prune_grant.sql')",
    );
    assert.equal(migrations.rowCount, 2, "expected all PostgreSQL migrations to be applied");

    const keyword = await store.memoryAdd(actor, {
      tenant: "default",
      project,
      namespace: "test",
      kind: "note",
      title: "Keyword target",
      body: "The blue deployment pipeline uses keyword search.",
      source_type: "manual",
      source_ref: "postgres-smoke",
    });
    assert.equal(keyword.accepted, true);

    const duplicate = await store.memoryAdd(actor, {
      tenant: "default",
      project,
      namespace: "test",
      kind: "note",
      title: "Keyword target",
      body: "The blue deployment pipeline uses keyword search.",
      source_type: "manual",
      source_ref: "postgres-smoke",
    });
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.id, keyword.id);
    assert.deepEqual(duplicate.warnings, ["duplicate_content"]);

    const semantic = await store.memoryAdd(actor, {
      tenant: "default",
      project,
      namespace: "test",
      kind: "note",
      title: "Vector target",
      body: "This note should be found through vector similarity.",
      source_type: "manual",
      source_ref: "postgres-smoke",
    });
    assert.equal(semantic.accepted, true);

    await pool.query(
      `
      INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
      SELECT id, $2, $3::vector, content_hash
      FROM memory_items
      WHERE id = $1
      `,
      [keyword.id, "test-model", "[0.1,0.9,0.1]"],
    );
    await pool.query(
      `
      INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
      SELECT id, $2, $3::vector, content_hash
      FROM memory_items
      WHERE id = $1
      `,
      [semantic.id, "test-model", "[0.9,0.1,0.1]"],
    );

    const keywordResults = await store.memorySearch({
      tenant: "default",
      project,
      namespace: "test",
      query: "blue deployment",
      limit: 5,
    }) as any[];
    assert.equal(keywordResults[0].id, keyword.id);
    assert.equal(keywordResults[0].search_mode, "keyword");

    const hybridFallback = (await withoutEmbeddingConfig(() =>
      store.memorySearch({
        tenant: "default",
        project,
        namespace: "test",
        query: "blue deployment",
        limit: 5,
        mode: "hybrid",
      }),
    )) as any[];
    assert.equal(hybridFallback[0].id, keyword.id);
    assert.equal(hybridFallback[0].search_mode, "keyword");

    await withoutEmbeddingConfig(() =>
      assert.rejects(
        () =>
        store.memorySearch({
          tenant: "default",
          project,
          namespace: "test",
          query: "meaningful vector query",
          limit: 5,
          mode: "semantic",
        }),
        /semantic search requires embedding_model/i,
      ),
    );

    const semanticResults = await store.memorySearch({
      tenant: "default",
      project,
      namespace: "test",
      query: "meaningful vector query",
      limit: 5,
      mode: "semantic",
      embedding_model: "test-model",
      query_embedding: [1, 0, 0],
    }) as any[];
    assert.equal(semanticResults[0].id, semantic.id);
    assert.equal(semanticResults[0].search_mode, "semantic");
    assert.equal(semanticResults[0].embedding_model, "test-model");

    const hybridResults = await store.memorySearch({
      tenant: "default",
      project,
      namespace: "test",
      query: "blue deployment",
      limit: 5,
      mode: "hybrid",
      embedding_model: "test-model",
      query_embedding: [1, 0, 0],
    }) as any[];
    assert.ok(hybridResults.some((item) => item.id === keyword.id), "hybrid should include keyword match");
    assert.ok(hybridResults.some((item) => item.id === semantic.id), "hybrid should include semantic match");
    assert.equal(hybridResults[0].search_mode, "hybrid");

    const observation = await store.observationAdd(actor, {
      tenant: "default",
      project,
      observation: "This expired observation must be pruned.",
      ttl_days: 1,
    });
    await pool.query(
      "UPDATE agent_observations SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [observation.id],
    );
    const prune = await runPruneScript();
    assert.ok(prune.deleted_count >= 1, "expected expired observation pruning");
    const pruned = await pool.query("SELECT 1 FROM agent_observations WHERE id = $1", [observation.id]);
    assert.equal(pruned.rowCount, 0);

    console.log("postgres smoke ok");
  } finally {
    await cleanupProject();
    await store.close();
  }
}

async function cleanupProject() {
  const params = ["default", project];
  await pool.query(
    `DELETE FROM memory_embeddings me
     USING memory_items mi
     WHERE me.memory_id = mi.id AND mi.tenant = $1 AND mi.project = $2`,
    params,
  );
  await pool.query("DELETE FROM agent_observations WHERE tenant = $1 AND project = $2", params);
  await pool.query("DELETE FROM project_contexts WHERE tenant = $1 AND project = $2", params);
  await pool.query("DELETE FROM audit_events WHERE tenant = $1 AND project = $2", params);
  await pool.query("DELETE FROM memory_items WHERE tenant = $1 AND project = $2", params);
}

async function runPruneScript(): Promise<{ deleted_count: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/prune-observations.mjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`prune-observations failed with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { deleted_count: number });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function withoutEmbeddingConfig<T>(callback: () => Promise<T>): Promise<T> {
  const keys = ["AGENT_MEMORY_EMBEDDING_MODEL", "AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
