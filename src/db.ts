import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Pool } from "pg";

export function createPgPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    database: process.env.PGDATABASE ?? "agent_memory",
    host: process.env.PGHOST ?? "/var/run/postgresql",
    user: process.env.PGUSER,
  });
}

export async function migrate() {
  const pool = createPgPool();
  const migrationsDir = resolve("migrations");

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (applied.rowCount) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), "utf8");
      await pool.query("BEGIN");
      try {
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await pool.query("COMMIT");
        console.log(`applied ${file}`);
      } catch (error) {
        await pool.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}
