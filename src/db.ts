import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function createPgPool(): Pool {
  // Precedence (node-postgres semantics): explicitly provided discrete
  // parameters win over DATABASE_URL components; PG* environment variables
  // are read by pg itself and sit between the two. Prefer DATABASE_URL for
  // full connection specs; use the discrete params for partial overrides.
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    database: process.env.PGDATABASE ?? "agent_memory",
    host: process.env.PGHOST ?? "/var/run/postgresql",
    user: process.env.PGUSER,
    // Review finding #9: explicit pool bounds instead of library defaults.
    // A local sidecar needs only a handful of connections; a bounded wait
    // fails fast instead of piling up unbounded queues.
    max: positiveIntEnv("AGENT_MEMORY_PG_POOL_MAX", 10),
    connectionTimeoutMillis: positiveIntEnv("AGENT_MEMORY_PG_CONNECT_TIMEOUT_MS", 5_000),
    statement_timeout: positiveIntEnv("AGENT_MEMORY_PG_STATEMENT_TIMEOUT_MS", 30_000),
  });
}

export async function migrate() {
  const pool = createPgPool();
  const migrationsDir = resolve("migrations");
  const client = await pool.connect();

  try {
    // Serialize concurrent migrators: node-pg Pool#query may lease a different
    // connection per call, so BEGIN/DDL/COMMIT must run on one dedicated
    // client, and two processes racing `db:migrate` need an advisory lock
    // around the check-then-insert on schema_migrations.
    await client.query("SELECT pg_advisory_lock(hashtext('agents_memory_migrate'))");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (applied.rowCount) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), "utf8");
      // Each migration runs atomically on this same client: DDL + bookkeeping
      // commit together or roll back together.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('agents_memory_migrate'))");
    } catch {
      // Connection already broken: session teardown releases the lock.
    } finally {
      client.release();
      await pool.end();
    }
  }
}
