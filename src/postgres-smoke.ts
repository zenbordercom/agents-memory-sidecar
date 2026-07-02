import { strict as assert } from "node:assert";
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

async function main() {
  try {
    const keyword = await store.memoryAdd(actor, {
      tenant: "default",
      project: "semantic-smoke",
      namespace: "test",
      kind: "note",
      title: "Keyword target",
      body: "The blue deployment pipeline uses keyword search.",
      source_type: "manual",
      source_ref: "postgres-smoke",
    });
    assert.equal(keyword.accepted, true);

    const semantic = await store.memoryAdd(actor, {
      tenant: "default",
      project: "semantic-smoke",
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
      project: "semantic-smoke",
      namespace: "test",
      query: "blue deployment",
      limit: 5,
    }) as any[];
    assert.equal(keywordResults[0].id, keyword.id);
    assert.equal(keywordResults[0].search_mode, "keyword");

    const semanticResults = await store.memorySearch({
      tenant: "default",
      project: "semantic-smoke",
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
      project: "semantic-smoke",
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

    console.log("postgres smoke ok");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
