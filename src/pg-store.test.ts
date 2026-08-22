import assert from "node:assert/strict";
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
});
