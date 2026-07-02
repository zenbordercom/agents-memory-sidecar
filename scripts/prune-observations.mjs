#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const dryRun = args["dry-run"] === "true";

loadEnvFile(envFile);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

try {
  const result = dryRun ? await countExpired() : await deleteExpired();
  console.log(JSON.stringify({ dry_run: dryRun, ...result }, null, 2));
} finally {
  await pool.end();
}

async function countExpired() {
  const result = await pool.query(
    `
    SELECT count(*)::int AS expired_count
    FROM agent_observations
    WHERE expires_at IS NOT NULL AND expires_at < now()
    `,
  );
  return { expired_count: result.rows[0].expired_count };
}

async function deleteExpired() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query(
      `
      DELETE FROM agent_observations
      WHERE expires_at IS NOT NULL AND expires_at < now()
      RETURNING tenant, project, id
      `,
    );

    const byProject = new Map();
    for (const row of deleted.rows) {
      const key = `${row.tenant}/${row.project}`;
      byProject.set(key, (byProject.get(key) ?? 0) + 1);
    }

    if (deleted.rowCount > 0) {
      await client.query(
        `
        INSERT INTO audit_events (
          id, tenant, actor, agent_id, runtime, action, target_type, project, request_id, metadata
        )
        VALUES ($1, NULL, 'system:agents-memory-maintenance', 'agents-memory-maintenance', 'system',
          'observation.prune', 'agent_observation', NULL, $2, $3)
        `,
        [
          randomUUID(),
          randomUUID(),
          {
            deleted_count: deleted.rowCount,
            by_project: Object.fromEntries(byProject),
          },
        ],
      );
    }

    await client.query("COMMIT");
    return { deleted_count: deleted.rowCount, by_project: Object.fromEntries(byProject) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value}`);
    }
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}
