import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { migrate } from "./db.js";
import { PgStore } from "./pg-store.js";
import type { Actor } from "./types.js";

// Regression suite for the v0.3.3 correctness batch (review findings #1 and #2).
// These tests exercise a REAL PostgreSQL database because they assert on
// concurrency, unique-index arbitration, and transactional rollback behaviour
// that cannot be reproduced against mocks or the FakeStore.
//
// Opt-in via environment so the default `npm test` stays hermetic:
//   AGENT_MEMORY_TEST_PG=1        enable the suite
//   PGDATABASE=<test database>    target database (must NOT be "agent_memory",
//                                 the local production default, as a guard)
//
// The target database needs the pgvector extension available (the CI
// pgvector/pgvector:pg16 image provides it; locally pre-create once with
// `sudo -u postgres createdb <name> && sudo -u postgres psql <name> -c
// 'CREATE EXTENSION IF NOT EXISTS vector'`). Tables are dropped and recreated
// per test via migrations, so point this ONLY at a disposable database.

const pgEnabled = process.env.AGENT_MEMORY_TEST_PG === "1";
const targetDatabase = process.env.PGDATABASE ?? "";
const guarded = pgEnabled && targetDatabase.length > 0 && targetDatabase !== "agent_memory";

function makeActor(suffix: string): Actor {
  return {
    tenant: "tenant-test",
    agentId: `agent-${suffix}`,
    runtime: "regression-test",
    role: "writer",
    projects: ["project-test"],
  };
}

test("pg store correctness regression", { skip: !guarded }, async (t) => {
  const { createPgPool } = await import("./db.js");
  const pool = createPgPool();
  t.after(() => pool.end());

  const MIGRATION_TABLES = [
    "audit_events",
    "memory_embeddings",
    "agent_observations",
    "project_contexts",
    "memory_items",
    "schema_migrations",
  ];

  async function resetTables() {
    // Drop in any order via CASCADE; extensions (vector) are schema-level and survive.
    await pool.query(`DROP TABLE IF EXISTS ${MIGRATION_TABLES.join(", ")} CASCADE`);
  }

  async function auditActionCounts(): Promise<Map<string, number>> {
    const result = await pool.query(
      "SELECT action, count(*)::int AS n FROM audit_events WHERE target_type = 'memory_item' GROUP BY action",
    );
    return new Map(result.rows.map((row) => [row.action as string, row.n as number]));
  }

  await t.test("migrate applies cleanly on a fresh database", async () => {
    await resetTables();
    await migrate();
    const applied = await pool.query("SELECT name FROM schema_migrations ORDER BY name");
    assert.ok(applied.rowCount && applied.rowCount >= 2);
  });

  await t.test("concurrent migrate calls serialize via advisory lock", async () => {
    await resetTables();
    // Two migrators racing must both succeed and record each file exactly once.
    await Promise.all([migrate(), migrate()]);
    const duplicates = await pool.query(
      "SELECT name, count(*)::int AS n FROM schema_migrations GROUP BY name HAVING count(*) > 1",
    );
    assert.equal(duplicates.rowCount, 0);
  });

  await t.test("prune grant is present and survives migration replay", async () => {
    await resetTables();
    await migrate();
    const role = await pool.query("SELECT to_regrole('agent_memory_app') AS reg");
    if (!role.rows[0].reg) {
      t.skip("agent_memory_app role not present in this cluster");
      return;
    }
    const granted = () =>
      pool.query("SELECT has_table_privilege('agent_memory_app', 'agent_observations', 'DELETE') AS ok");
    assert.equal((await granted()).rows[0].ok, true);
    // Replay: re-running all migrations must stay idempotent and keep the grant.
    await migrate();
    assert.equal((await granted()).rows[0].ok, true);
  });

  await t.test("failed migration rolls back fully and records nothing", async () => {
    await resetTables();

    const tmp = await mkdtemp(join(tmpdir(), "sidecar-migrate-"));
    await cp(resolve("migrations"), join(tmp, "migrations"), { recursive: true });
    await writeFile(
      join(tmp, "migrations", "900_failing.sql"),
      ["CREATE TABLE rollback_probe (id int);", "INSERT INTO table_that_does_not_exist (id) VALUES (1);", ""].join("\n"),
    );

    const previousCwd = process.cwd();
    process.chdir(tmp);
    try {
      await assert.rejects(() => migrate(), /table_that_does_not_exist|does not exist/i);
    } finally {
      process.chdir(previousCwd);
      await rm(tmp, { recursive: true, force: true });
    }

    // Atomicity: the DDL from before the failure must be rolled back...
    const probe = await pool.query("SELECT to_regclass('public.rollback_probe') AS reg");
    assert.equal(probe.rows[0].reg, null);
    // ...and the failing migration must NOT be recorded as applied.
    const recorded = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '900_failing.sql'");
    assert.equal(recorded.rowCount, 0);
    // Migrations applied before the failure remain committed.
    const good = await pool.query("SELECT 1 FROM schema_migrations WHERE name = '001_initial.sql'");
    assert.equal(good.rowCount, 1);
  });

  await t.test("sequential duplicate add returns duplicate_content with audit", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("seq");

    const base = {
      tenant: actor.tenant,
      project: "project-test",
      namespace: "ops",
      kind: "note",
      title: "Duplicate probe",
      body: "identical body for dedup",
      source_type: "manual" as const,
    };

    const first = await store.memoryAdd(actor, base);
    assert.equal(first.accepted, true);
    assert.deepEqual(first.warnings, []);

    const second = await store.memoryAdd(makeActor("seq-2"), base);
    assert.equal(second.accepted, false);
    assert.deepEqual(second.warnings, ["duplicate_content"]);
    assert.equal(second.id, first.id);

    const counts = await auditActionCounts();
    assert.equal(counts.get("memory.add"), 1);
    assert.equal(counts.get("memory.duplicate"), 1);

    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM memory_items WHERE tenant = $1 AND project = $2 AND namespace = $3",
      [base.tenant, base.project, base.namespace],
    );
    assert.equal(rows.rows[0].n, 1);
  });

  await t.test("concurrent duplicate adds elect a single winner", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);

    const base = {
      tenant: "tenant-race",
      project: "project-race",
      namespace: "ops",
      kind: "note",
      body: "racing writers insert the same content simultaneously",
      source_type: "agent" as const,
    };

    const CONCURRENCY = 8;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        store.memoryAdd(makeActor(`race-${i}`), base),
      ),
    );

    const accepted = results.filter((r) => r.accepted);
    const rejected = results.filter((r) => !r.accepted);
    assert.equal(accepted.length, 1, `exactly one winner expected, got ${accepted.length}`);
    assert.equal(rejected.length, CONCURRENCY - 1);
    for (const rejectedResult of rejected) {
      assert.deepEqual(rejectedResult.warnings, ["duplicate_content"]);
      assert.equal(rejectedResult.id, accepted[0].id);
    }

    const rows = await pool.query(
      "SELECT count(*)::int AS n FROM memory_items WHERE tenant = $1 AND project = $2",
      [base.tenant, base.project],
    );
    assert.equal(rows.rows[0].n, 1);

    const counts = await auditActionCounts();
    assert.equal(counts.get("memory.add"), 1);
    assert.equal(counts.get("memory.duplicate"), CONCURRENCY - 1);
  });

  await t.test("keyword search ranks, filters, and excludes dead rows", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("search");

    await store.memoryAdd(actor, {
      tenant: "t-search",
      project: "p-search",
      namespace: "ops",
      kind: "note",
      title: "Deploy runbook",
      body: "deployment steps for the api service include rolling restart and health verification",
      source_type: "manual",
    });
    await store.memoryAdd(actor, {
      tenant: "t-search",
      project: "p-search",
      namespace: "archive",
      kind: "note",
      title: "Unrelated",
      body: "deployment steps for the api service include rolling restart and health verification",
      source_type: "manual",
    });

    const hit = await store.memorySearch({ tenant: "t-search", project: "p-search", query: "deployment restart", limit: 5 });
    assert.equal(hit.length, 2, "both namespaces match without a namespace filter");

    const scoped = await store.memorySearch({ tenant: "t-search", project: "p-search", query: "deployment restart", namespace: "ops", limit: 5 });
    assert.equal(scoped.length, 1, "namespace filter must apply");
    assert.equal(scoped[0].search_mode, "keyword");
    assert.equal(scoped[0].title, "Deploy runbook");
    assert.match(String(scoped[0].body_excerpt), /deployment/i);

    const byKind = await store.memorySearch({ tenant: "t-search", project: "p-search", query: "deployment", kind: "incident", limit: 5 });
    assert.equal(byKind.length, 0);

    // Expired rows are invisible to search and get.
    await pool.query(
      `INSERT INTO memory_items (id, tenant, project, namespace, kind, body, source_type, expires_at)
       VALUES (gen_random_uuid(), 't-search', 'p-search', 'ops', 'note', 'expired deployment secret', 'manual', now() - interval '1 day')`,
    );
    const afterExpiry = await store.memorySearch({ tenant: "t-search", project: "p-search", query: "expired secret", limit: 5 });
    assert.equal(afterExpiry.length, 0);

    // Soft-deleted rows are invisible too.
    await pool.query(
      `INSERT INTO memory_items (id, tenant, project, namespace, kind, body, source_type, deleted_at)
       VALUES (gen_random_uuid(), 't-search', 'p-search', 'ops', 'note', 'deleted deployment note', 'manual', now())`,
    );
    const afterDelete = await store.memorySearch({ tenant: "t-search", project: "p-search", query: "deleted deployment", limit: 5 });
    assert.equal(afterDelete.length, 0);
  });

  await t.test("memoryGet returns live items only", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("get");

    const added = await store.memoryAdd(actor, {
      tenant: "t-get",
      project: "p-get",
      namespace: "ops",
      kind: "note",
      body: "readable body",
      confidence: 0.9,
      source_type: "manual",
    });

    const item = await store.memoryGet({ tenant: "t-get", project: "p-get", id: added.id });
    assert.ok(item);
    assert.equal(item!.confidence, 0.9);
    assert.ok(item!.created_at);

    assert.equal(await store.memoryGet({ tenant: "t-other", project: "p-get", id: added.id }), undefined);
    assert.equal(await store.memoryGet({ tenant: "t-get", project: "p-get", id: randomUUID() }), undefined);

    await pool.query("UPDATE memory_items SET deleted_at = now() WHERE id = $1", [added.id]);
    assert.equal(await store.memoryGet({ tenant: "t-get", project: "p-get", id: added.id }), undefined);
  });

  await t.test("contextGet honours the optional key filter", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("ctx");

    for (const key of ["api-base", "db-host", "deploy-path"]) {
      await store.contextSet(actor, { tenant: "t-ctx", project: "p-ctx", key, value: { v: key } });
    }

    const all = await store.contextGet({ tenant: "t-ctx", project: "p-ctx" });
    assert.equal(all.length, 3);

    const some = await store.contextGet({ tenant: "t-ctx", project: "p-ctx", keys: ["api-base", "deploy-path"] });
    assert.deepEqual(some.map((c) => c.key).sort(), ["api-base", "deploy-path"]);
  });

  await t.test("semantic search matches embeddings and enforces dimension equality", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("sem");

    const added = await store.memoryAdd(actor, {
      tenant: "t-sem",
      project: "p-sem",
      namespace: "ops",
      kind: "note",
      body: "vector search probe",
      source_type: "manual",
    });
    await pool.query(
      `INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
       VALUES ($1, 'test-model', $2::vector, 'hash-sem')`,
      [added.id, "[1, 0, 0, 0]"],
    );

    const hits = await store.memorySearch({
      tenant: "t-sem",
      project: "p-sem",
      query: "probe",
      mode: "semantic",
      embedding_model: "test-model",
      query_embedding: [1, 0.001, 0, 0],
      limit: 5,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, added.id);
    assert.equal(hits[0].search_mode, "semantic");
    assert.equal(hits[0].embedding_model, "test-model");
    assert.ok(Number(hits[0].semantic_score) > 0.99);

    // Dimension mismatch is filtered out, not an error.
    const wrongDims = await store.memorySearch({
      tenant: "t-sem",
      project: "p-sem",
      query: "probe",
      mode: "semantic",
      embedding_model: "test-model",
      query_embedding: [1, 0],
      limit: 5,
    });
    assert.equal(wrongDims.length, 0);

    // Unknown model -> no rows.
    const otherModel = await store.memorySearch({
      tenant: "t-sem",
      project: "p-sem",
      query: "probe",
      mode: "semantic",
      embedding_model: "other-model",
      query_embedding: [1, 0, 0, 0],
      limit: 5,
    });
    assert.equal(otherModel.length, 0);
  });

  await t.test("hybrid search merges keyword and semantic scores inside scope", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("hyb");

    const both = await store.memoryAdd(actor, {
      tenant: "t-hyb",
      project: "p-hyb",
      namespace: "ops",
      kind: "note",
      title: "Cache eviction policy",
      body: "cache eviction follows lru with ttl overrides",
      source_type: "manual",
    });
    await pool.query(
      `INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
       VALUES ($1, 'test-model', $2::vector, 'hash-hyb')`,
      [both.id, "[0, 1]"],
    );
    const keywordOnly = await store.memoryAdd(actor, {
      tenant: "t-hyb",
      project: "p-hyb",
      namespace: "ops",
      kind: "note",
      title: "Cache invalidation note",
      body: "cache invalidation happens on deploy",
      source_type: "manual",
    });
    // In-scope row matching NEITHER keyword nor embedding: must not appear.
    await store.memoryAdd(actor, {
      tenant: "t-hyb",
      project: "p-hyb",
      namespace: "ops",
      kind: "note",
      title: "Gardening schedule",
      body: "water the plants on mondays",
      source_type: "manual",
    });

    const results = await store.memorySearch({
      tenant: "t-hyb",
      project: "p-hyb",
      query: "cache",
      mode: "hybrid",
      embedding_model: "test-model",
      query_embedding: [0, 1],
      limit: 10,
    });
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes(both.id), "row matching both legs must appear");
    assert.ok(ids.includes(keywordOnly.id), "keyword-only row must still surface");
    assert.equal(results.length, 2, "rows matching neither leg must be excluded");

    const merged = results.find((r) => r.id === both.id)!;
    assert.ok(Number(merged.keyword_score) > 0);
    assert.ok(merged.semantic_score !== undefined);
    assert.equal(results.find((r) => r.id === keywordOnly.id)!.semantic_score, undefined);
    assert.equal(results[0].id, both.id, "merged score should outrank keyword-only");
  });

  await t.test("auditEvent writes a queryable record", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const actor = makeActor("audit");

    await store.auditEvent({
      tenant: actor.tenant,
      actor,
      action: "custom.probe",
      target_type: "http_request",
      project: "p-audit",
      request_id: "req-123",
      metadata: { via: "test" },
    });

    const row = await pool.query(
      "SELECT action, actor, agent_id, project, request_id FROM audit_events WHERE action = 'custom.probe'",
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0].actor, `${actor.runtime}:${actor.agentId}`);
    assert.equal(row.rows[0].request_id, "req-123");
  });

  await t.test("memoryDelete soft-deletes with audit and frees the content hash", async () => {
    await resetTables();
    await migrate();
    const store = new PgStore(pool);
    const writer = makeActor("del-writer");
    const admin = { ...makeActor("del-admin"), role: "admin" as const };

    const base = {
      tenant: "t-del",
      project: "p-del",
      namespace: "ops",
      kind: "note",
      body: "sensitive payload that must be removed",
      source_type: "manual" as const,
    };
    const added = await store.memoryAdd(writer, base);

    // Unknown id / cross-tenant no-ops.
    assert.deepEqual(await store.memoryDelete(admin, { tenant: "t-del", project: "p-del", id: randomUUID() }), { deleted: false });
    assert.deepEqual(await store.memoryDelete(admin, { tenant: "other", project: "p-del", id: added.id }), { deleted: false });

    assert.deepEqual(await store.memoryDelete(admin, { tenant: "t-del", project: "p-del", id: added.id }), { deleted: true });

    // Invisible to reads and search...
    assert.equal(await store.memoryGet({ tenant: "t-del", project: "p-del", id: added.id }), undefined);
    assert.equal((await store.memorySearch({ tenant: "t-del", project: "p-del", query: "sensitive payload", limit: 5 })).length, 0);

    // ...and the partial unique index no longer blocks re-adding the same content.
    const reAdded = await store.memoryAdd(writer, base);
    assert.equal(reAdded.accepted, true, "same content must be addable after soft delete");
    assert.notEqual(reAdded.id, added.id);

    // Second delete of the same row is a no-op (already deleted).
    assert.deepEqual(await store.memoryDelete(admin, { tenant: "t-del", project: "p-del", id: added.id }), { deleted: false });

    const audits = await pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'memory.delete' AND target_id = $1",
      [added.id],
    );
    assert.equal(audits.rows[0].n, 1);
  });

  await t.test("audit failure rolls back the write on all three paths", async () => {
    await resetTables();
    await migrate();

    // Wrapper that fails the next INSERT INTO audit_events when armed, then
    // passes everything else through to the real pool (clients included).
    function makeAuditFailingPool(real: typeof pool) {
      let failNextAuditInsert = false;
      const wrapQuery =
        <Q extends { query(sql: string, params?: unknown[]): Promise<unknown> }>(underlying: Q): Q =>
          new Proxy(underlying, {
            get(target, prop, receiver) {
              if (prop === "query") {
                return async (sql: string, params?: unknown[]) => {
                  if (failNextAuditInsert && sql.includes("INSERT INTO audit_events")) {
                    failNextAuditInsert = false;
                    throw new Error("simulated audit outage");
                  }
                  return (target.query as (s: string, p?: unknown[]) => Promise<unknown>)(sql, params);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          }) as Q;

      return {
        query: wrapQuery(real).query.bind(wrapQuery(real)),
        connect: async () => wrapQuery(await real.connect()),
        end: () => real.end(),
        armAuditFailure: () => {
          failNextAuditInsert = true;
        },
      };
    }

    const flaky = makeAuditFailingPool(pool);
    const store = new PgStore(flaky as unknown as typeof pool);
    const actor = makeActor("txn");

    flaky.armAuditFailure();
    await assert.rejects(() =>
      store.contextSet(actor, { tenant: actor.tenant, project: "p-txn", key: "k", value: { v: 1 } }),
    );
    const contexts = await pool.query(
      "SELECT count(*)::int AS n FROM project_contexts WHERE tenant = $1 AND project = $2",
      [actor.tenant, "p-txn"],
    );
    assert.equal(contexts.rows[0].n, 0, "context write must roll back when audit fails");

    flaky.armAuditFailure();
    await assert.rejects(() =>
      store.observationAdd(actor, {
        tenant: actor.tenant,
        project: "p-txn",
        observation: "should not persist",
        ttl_days: 1,
      }),
    );
    const observations = await pool.query(
      "SELECT count(*)::int AS n FROM agent_observations WHERE tenant = $1 AND project = $2",
      [actor.tenant, "p-txn"],
    );
    assert.equal(observations.rows[0].n, 0, "observation write must roll back when audit fails");

    flaky.armAuditFailure();
    await assert.rejects(() =>
      store.memoryAdd(actor, {
        tenant: actor.tenant,
        project: "p-txn",
        namespace: "ops",
        kind: "note",
        body: "should not persist",
        source_type: "manual",
      }),
    );
    const memories = await pool.query(
      "SELECT count(*)::int AS n FROM memory_items WHERE tenant = $1 AND project = $2",
      [actor.tenant, "p-txn"],
    );
    assert.equal(memories.rows[0].n, 0, "memory write must roll back when audit fails");

    // After the injected failure is consumed, writes succeed end-to-end.
    const ok = await store.contextSet(actor, { tenant: actor.tenant, project: "p-txn", key: "k", value: { v: 2 } });
    assert.equal(ok.accepted, true);
  });
});
