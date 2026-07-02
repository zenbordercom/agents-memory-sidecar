#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const longBodyChars = Number(args["long-body-chars"] ?? 4000);
const lowConfidence = Number(args["low-confidence"] ?? 0.5);
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
    const [counts, missingSummary, longBodies, lowConfidenceItems, duplicateHashes, expiredObservations] = await Promise.all([
      pool.query(`
        SELECT 'memory_items' AS key, count(*)::int AS count FROM memory_items WHERE deleted_at IS NULL
        UNION ALL SELECT 'project_contexts', count(*)::int FROM project_contexts
        UNION ALL SELECT 'agent_observations', count(*)::int FROM agent_observations
        UNION ALL SELECT 'audit_events', count(*)::int FROM audit_events
        ORDER BY key
      `),
      pool.query(
        `
        SELECT id, project, namespace, kind, title, created_at
        FROM memory_items
        WHERE deleted_at IS NULL
          AND (summary IS NULL OR length(trim(summary)) = 0)
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit],
      ),
      pool.query(
        `
        SELECT id, project, namespace, kind, title, length(body)::int AS body_chars, created_at
        FROM memory_items
        WHERE deleted_at IS NULL
          AND length(body) > $1
        ORDER BY length(body) DESC
        LIMIT $2
        `,
        [longBodyChars, limit],
      ),
      pool.query(
        `
        SELECT id, project, namespace, kind, title, confidence, created_at
        FROM memory_items
        WHERE deleted_at IS NULL
          AND (confidence IS NULL OR confidence < $1)
        ORDER BY confidence NULLS FIRST, created_at DESC
        LIMIT $2
        `,
        [lowConfidence, limit],
      ),
      pool.query(
        `
        SELECT tenant, project, namespace, content_hash, count(*)::int AS count,
               array_agg(id ORDER BY created_at DESC) AS ids,
               array_agg(title ORDER BY created_at DESC) AS titles
        FROM memory_items
        WHERE deleted_at IS NULL
          AND content_hash IS NOT NULL
        GROUP BY tenant, project, namespace, content_hash
        HAVING count(*) > 1
        ORDER BY count(*) DESC
        LIMIT $1
        `,
        [limit],
      ),
      pool.query(`
        SELECT count(*)::int AS count
        FROM agent_observations
        WHERE expires_at IS NOT NULL AND expires_at < now()
      `),
    ]);

    const issues = {
      missing_summary: summarizeRows(missingSummary.rows),
      long_bodies: summarizeRows(longBodies.rows),
      low_confidence: summarizeRows(lowConfidenceItems.rows),
      duplicate_hashes: duplicateHashes.rows.map((row) => ({
        tenant: row.tenant,
        project: row.project,
        namespace: row.namespace,
        content_hash: row.content_hash,
        count: row.count,
        ids: row.ids,
        titles: row.titles,
      })),
      expired_observations: expiredObservations.rows[0]?.count ?? 0,
    };

    const issueCount =
      issues.missing_summary.length +
      issues.long_bodies.length +
      issues.low_confidence.length +
      issues.duplicate_hashes.length +
      issues.expired_observations;

    return {
      status: "ok",
      generated_at: new Date().toISOString(),
      thresholds: {
        long_body_chars: longBodyChars,
        low_confidence: lowConfidence,
        limit,
      },
      counts: Object.fromEntries(counts.rows.map((row) => [row.key, row.count])),
      issue_count: issueCount,
      issues,
      note: "This report is read-only and intentionally omits memory bodies, request bodies, bearer tokens, database passwords, and backup passphrases.",
    };
  } catch (error) {
    return { status: "fail", error: error?.message ?? String(error) };
  }
}

function summarizeRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    project: row.project,
    namespace: row.namespace,
    kind: row.kind,
    title: row.title,
    body_chars: row.body_chars,
    confidence: row.confidence,
    created_at: row.created_at,
  }));
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
