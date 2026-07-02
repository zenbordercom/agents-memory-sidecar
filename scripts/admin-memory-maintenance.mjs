#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const dryRun = args["dry-run"] === "true";
const tenant = args.tenant ?? "default";

loadEnvFile(envFile);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

try {
  if (args.help === "true" || !command) {
    printHelp();
  } else if (command === "update-summary") {
    await updateSummary();
  } else if (command === "soft-delete") {
    await softDelete();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await pool.end();
}

async function updateSummary() {
  const id = required(args, "id");
  const project = required(args, "project");
  const summary = required(args, "summary");
  const reason = args.reason ?? "admin summary update";
  const warnings = scanForSecrets(summary);
  if (warnings.length > 0) {
    console.log(JSON.stringify({ accepted: false, dry_run: dryRun, warnings }, null, 2));
    return;
  }

  await withMemory(id, project, async (client, memory) => {
    if (dryRun) {
      console.log(JSON.stringify({ accepted: true, dry_run: true, action: "memory.update_summary", target: summarizeMemory(memory), new_summary_length: summary.length }, null, 2));
      return;
    }
    await client.query(
      `
      UPDATE memory_items
      SET summary = $1, updated_at = now()
      WHERE tenant = $2 AND project = $3 AND id = $4 AND deleted_at IS NULL
      `,
      [summary, tenant, project, id],
    );
    await audit(client, "memory.update_summary", project, id, { reason, old_summary_length: memory.summary?.length ?? 0, new_summary_length: summary.length });
    console.log(JSON.stringify({ accepted: true, dry_run: false, action: "memory.update_summary", id }, null, 2));
  });
}

async function softDelete() {
  const id = required(args, "id");
  const project = required(args, "project");
  const reason = required(args, "reason");

  await withMemory(id, project, async (client, memory) => {
    if (dryRun) {
      console.log(JSON.stringify({ accepted: true, dry_run: true, action: "memory.soft_delete", target: summarizeMemory(memory), reason }, null, 2));
      return;
    }
    await client.query(
      `
      UPDATE memory_items
      SET deleted_at = now(), updated_at = now()
      WHERE tenant = $1 AND project = $2 AND id = $3 AND deleted_at IS NULL
      `,
      [tenant, project, id],
    );
    await audit(client, "memory.soft_delete", project, id, { reason });
    console.log(JSON.stringify({ accepted: true, dry_run: false, action: "memory.soft_delete", id }, null, 2));
  });
}

async function withMemory(id, project, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT id, tenant, project, namespace, kind, title, summary, created_at
      FROM memory_items
      WHERE tenant = $1 AND project = $2 AND id = $3 AND deleted_at IS NULL
      FOR UPDATE
      `,
      [tenant, project, id],
    );
    const memory = result.rows[0];
    if (!memory) throw new Error(`No active memory found for project=${project} id=${id}`);
    await callback(client, memory);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function audit(client, action, project, targetId, metadata) {
  await client.query(
    `
    INSERT INTO audit_events (
      id, tenant, actor, agent_id, runtime, action, target_type, target_id, project, request_id, metadata
    )
    VALUES ($1, $2, 'manual:admin-memory-maintenance', 'admin-memory-maintenance', 'manual',
      $3, 'memory_item', $4, $5, $6, $7)
    `,
    [randomUUID(), tenant, action, targetId, project, randomUUID(), metadata],
  );
}

function summarizeMemory(memory) {
  return {
    id: memory.id,
    project: memory.project,
    namespace: memory.namespace,
    kind: memory.kind,
    title: memory.title,
    summary_length: memory.summary?.length ?? 0,
    created_at: memory.created_at,
  };
}

function scanForSecrets(value) {
  const patterns = [
    /(?:^|\b)\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
    /(?:^|\n)[A-Z0-9_]{3,}=(?:['"]?)[^\s'"]{16,}/,
    /\b(?:session|cookie|authorization)\s*[:=]\s*[A-Za-z0-9._~+/-]{20,}/i,
  ];
  return patterns.some((pattern) => pattern.test(value)) ? ["suspected_secret"] : [];
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
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

function required(values, key) {
  const value = values[key];
  if (!value || value === "true") throw new Error(`Missing required argument: --${key}`);
  return value;
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

function printHelp() {
  console.log(`Usage:
  admin-memory-maintenance.mjs update-summary --project PROJECT --id ID --summary TEXT [--reason TEXT] [--dry-run]
  admin-memory-maintenance.mjs soft-delete --project PROJECT --id ID --reason TEXT [--dry-run]

This CLI is for local admin use only. It writes audit_events for non-dry-run changes and never prints memory bodies.`);
}
