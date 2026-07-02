#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const model = args.model;
const limit = Number(args.limit ?? 50);
const pretty = args.pretty === "true";

loadEnvFile(envFile);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

try {
  const report = await buildReport();
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
  if (report.status === "fail") process.exitCode = 1;
} finally {
  await pool.end();
}

async function buildReport() {
  try {
    const [extension, counts, coverage] = await Promise.all([
      pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'"),
      pool.query(`
        SELECT
          (SELECT count(*)::int FROM memory_items WHERE deleted_at IS NULL) AS active_memory_items,
          (SELECT count(*)::int FROM memory_embeddings) AS embedding_rows,
          (SELECT count(DISTINCT embedding_model)::int FROM memory_embeddings) AS embedding_models
      `),
      pool.query(`
        SELECT
          me.embedding_model,
          count(*)::int AS rows,
          count(*) FILTER (WHERE mi.id IS NOT NULL AND me.content_hash = mi.content_hash)::int AS current_rows,
          count(*) FILTER (WHERE mi.id IS NULL OR me.content_hash IS DISTINCT FROM mi.content_hash)::int AS stale_rows,
          min(vector_dims(me.embedding))::int AS min_dimensions,
          max(vector_dims(me.embedding))::int AS max_dimensions
        FROM memory_embeddings me
        LEFT JOIN memory_items mi ON mi.id = me.memory_id AND mi.deleted_at IS NULL
        GROUP BY me.embedding_model
        ORDER BY me.embedding_model
      `),
    ]);

    const report = {
      status: "ok",
      generated_at: new Date().toISOString(),
      pgvector_version: extension.rows[0]?.extversion ?? null,
      counts: counts.rows[0],
      coverage: coverage.rows,
      requested_model: model ?? null,
      missing_or_stale_for_requested_model: [],
      note: "This report is read-only. It does not call an embedding model, write vectors, change memory_search ranking, or print memory bodies/secrets.",
    };

    if (model) {
      const missing = await pool.query(
        `
        SELECT mi.id, mi.project, mi.namespace, mi.kind, mi.title, mi.created_at,
               CASE
                 WHEN me.memory_id IS NULL THEN 'missing'
                 WHEN me.content_hash IS DISTINCT FROM mi.content_hash THEN 'stale'
                 ELSE 'current'
               END AS embedding_status
        FROM memory_items mi
        LEFT JOIN memory_embeddings me
          ON me.memory_id = mi.id
         AND me.embedding_model = $1
        WHERE mi.deleted_at IS NULL
          AND (me.memory_id IS NULL OR me.content_hash IS DISTINCT FROM mi.content_hash)
        ORDER BY mi.created_at DESC
        LIMIT $2
        `,
        [model, limit],
      );
      report.missing_or_stale_for_requested_model = missing.rows;
    }

    return report;
  } catch (error) {
    return { status: "fail", error: error?.message ?? String(error) };
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
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
