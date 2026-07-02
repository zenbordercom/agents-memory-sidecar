#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const backupDir = args["backup-dir"] ?? "/var/backups/agents-memory";
const tokenFile = args["token-file"] ?? "/etc/agents-memory/http-tokens.json";
const healthUrl = args["health-url"] ?? "http://127.0.0.1:18790/healthz";
const maxBackupAgeHours = Number(args["max-backup-age-hours"] ?? 36);
const pretty = args.pretty === "true";

loadEnvFile(envFile);

const checks = [];

await main();

async function main() {
  await checkSystemd("agents-memory-sidecar.service");
  await checkSystemd("agents-memory-backup.timer");
  await checkSystemd("agents-memory-observation-prune.timer");
  await checkHttpHealth();
  await checkDatabase();
  await checkLatestBackup();
  await checkTokenRegistry();

  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  console.log(JSON.stringify({ status, checks }, null, pretty ? 2 : 0));
  if (status === "fail") process.exitCode = 1;
}

async function checkSystemd(unit) {
  try {
    const active = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim();
    checks.push({ name: `systemd:${unit}`, status: active === "active" ? "ok" : "fail", active });
  } catch (error) {
    checks.push({ name: `systemd:${unit}`, status: "fail", error: formatError(error) });
  }
}

async function checkHttpHealth() {
  try {
    const response = await fetch(healthUrl);
    const payload = await response.json();
    checks.push({
      name: "http:healthz",
      status: response.ok && payload?.ok === true ? "ok" : "fail",
      http_status: response.status,
      backend: payload?.backend,
    });
  } catch (error) {
    checks.push({ name: "http:healthz", status: "fail", error: formatError(error) });
  }
}

async function checkDatabase() {
  const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  try {
    const counts = await pool.query(`
      SELECT 'memory_items' AS table_name, count(*)::int AS count FROM memory_items WHERE deleted_at IS NULL
      UNION ALL SELECT 'project_contexts', count(*)::int FROM project_contexts
      UNION ALL SELECT 'agent_observations', count(*)::int FROM agent_observations
      UNION ALL SELECT 'audit_events', count(*)::int FROM audit_events
      ORDER BY table_name
    `);
    const expired = await pool.query(`
      SELECT count(*)::int AS count
      FROM agent_observations
      WHERE expires_at IS NOT NULL AND expires_at < now()
    `);
    checks.push({
      name: "postgres:counts",
      status: "ok",
      counts: Object.fromEntries(counts.rows.map((row) => [row.table_name, row.count])),
      expired_observations: expired.rows[0]?.count ?? 0,
    });
  } catch (error) {
    checks.push({ name: "postgres:counts", status: "fail", error: formatError(error) });
  } finally {
    await pool.end();
  }
}

async function checkLatestBackup() {
  try {
    const backups = readdirSync(backupDir)
      .filter((name) => name.endsWith(".dump.gpg"))
      .map((name) => {
        const path = join(backupDir, name);
        return { name, path, stat: statSync(path) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const latest = backups[0];
    if (!latest) {
      checks.push({ name: "backup:latest", status: "fail", error: "No .dump.gpg backup found" });
      return;
    }
    const ageHours = (Date.now() - latest.stat.mtimeMs) / 3_600_000;
    checks.push({
      name: "backup:latest",
      status: ageHours <= maxBackupAgeHours ? "ok" : "warn",
      file: latest.path,
      age_hours: Number(ageHours.toFixed(2)),
      max_age_hours: maxBackupAgeHours,
      size_bytes: latest.stat.size,
    });
  } catch (error) {
    checks.push({ name: "backup:latest", status: "fail", error: formatError(error) });
  }
}

async function checkTokenRegistry() {
  try {
    if (!existsSync(tokenFile)) {
      checks.push({ name: "tokens:registry", status: "fail", error: "Token registry missing" });
      return;
    }
    const registry = JSON.parse(readFileSync(tokenFile, "utf8"));
    checks.push({
      name: "tokens:registry",
      status: "ok",
      actors: Object.entries(registry).map(([token, actor]) => ({
        fingerprint: fingerprint(token),
        agent_id: actor.agentId,
        runtime: actor.runtime,
        role: actor.role,
      })),
    });
  } catch (error) {
    checks.push({ name: "tokens:registry", status: "warn", error: formatError(error) });
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

function fingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function formatError(error) {
  return error?.message ?? String(error);
}
