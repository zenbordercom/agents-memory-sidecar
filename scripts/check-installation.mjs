#!/usr/bin/env node
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const tokenFile = args["token-file"] ?? "/etc/agents-memory/http-tokens.json";
const sourceDir = args["source-dir"] ?? process.cwd();
const runtimeDir = args["runtime-dir"] ?? "/opt/agents-memory-sidecar";
const backupDir = args["backup-dir"] ?? "/var/backups/agents-memory";
const healthUrl = args["health-url"] ?? "http://127.0.0.1:18790/healthz";
const pretty = args.pretty === "true";

loadEnvFile(envFile);

const checks = [];
await main();

async function main() {
  checkPath("source:checkout", sourceDir, { required: true });
  checkPath("runtime:copy", runtimeDir, { required: true });
  checkPath("runtime:mcp_wrapper", join(runtimeDir, "dist/server.js"), { required: true, readable: true });
  checkPath("runtime:http_server", join(runtimeDir, "dist/http-server.js"), { required: true, readable: true });
  checkPath("config:dir", args["config-dir"] ?? "/etc/agents-memory", { required: true, expectedMode: "750" });
  checkPath("config:sidecar_env", envFile, { required: true, expectedMode: "640" });
  checkPath("config:token_registry", tokenFile, { required: true, expectedMode: "640" });
  checkPath("backup:dir", backupDir, { required: true });

  checkSystemd("agents-memory-sidecar.service", "service");
  checkSystemd("agents-memory-backup.timer", "timer");
  checkSystemd("agents-memory-observation-prune.timer", "timer");
  checkSystemd("agents-memory-health-check.timer", "timer");

  await checkHttp();
  await checkPostgres();
  checkTokenRegistry();
  checkLatestBackup();

  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  console.log(JSON.stringify({ status, generated_at: new Date().toISOString(), checks }, null, pretty ? 2 : 0));
  if (status === "fail") process.exitCode = 1;
}

function checkPath(name, path, options = {}) {
  try {
    if (!existsSync(path)) {
      checks.push({ name, status: options.required ? "fail" : "warn", path, error: "missing" });
      return;
    }
    const stat = statSync(path);
    if (options.readable) accessSync(path, constants.R_OK);
    const mode = (stat.mode & 0o777).toString(8);
    const status = options.expectedMode && mode !== options.expectedMode ? "warn" : "ok";
    checks.push({ name, status, path, mode, uid: stat.uid, gid: stat.gid });
  } catch (error) {
    checks.push({ name, status: "fail", path, error: formatError(error) });
  }
}

function checkSystemd(unit, kind) {
  try {
    const active = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim();
    const enabled = execFileSync("systemctl", ["is-enabled", unit], { encoding: "utf8" }).trim();
    const activeOk = kind === "service" ? active === "active" : active === "active";
    const enabledOk = ["enabled", "static"].includes(enabled);
    checks.push({ name: `systemd:${unit}`, status: activeOk && enabledOk ? "ok" : "warn", active, enabled });
  } catch (error) {
    checks.push({ name: `systemd:${unit}`, status: "fail", error: formatError(error) });
  }
}

async function checkHttp() {
  try {
    const response = await fetch(healthUrl);
    const payload = await response.json();
    checks.push({
      name: "http:healthz",
      status: response.ok && payload?.ok === true && payload?.backend === "postgres" ? "ok" : "fail",
      http_status: response.status,
      backend: payload?.backend,
    });
  } catch (error) {
    checks.push({ name: "http:healthz", status: "fail", error: formatError(error) });
  }
}

async function checkPostgres() {
  const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  try {
    const [extension, migrations, counts] = await Promise.all([
      pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'"),
      pool.query("SELECT name, applied_at FROM schema_migrations ORDER BY name"),
      pool.query(`
        SELECT 'memory_items' AS key, count(*)::int AS count FROM memory_items WHERE deleted_at IS NULL
        UNION ALL SELECT 'project_contexts', count(*)::int FROM project_contexts
        UNION ALL SELECT 'agent_observations', count(*)::int FROM agent_observations
        UNION ALL SELECT 'audit_events', count(*)::int FROM audit_events
        ORDER BY key
      `),
    ]);
    checks.push({
      name: "postgres:schema",
      status: extension.rows[0] && migrations.rows.length > 0 ? "ok" : "fail",
      vector_version: extension.rows[0]?.extversion,
      migrations: migrations.rows,
      counts: Object.fromEntries(counts.rows.map((row) => [row.key, row.count])),
    });
  } catch (error) {
    checks.push({ name: "postgres:schema", status: "fail", error: formatError(error) });
  } finally {
    await pool.end();
  }
}

function checkTokenRegistry() {
  try {
    const registry = JSON.parse(readFileSync(tokenFile, "utf8"));
    const actors = Object.entries(registry).map(([token, actor]) => ({
      fingerprint: fingerprint(token),
      agent_id: actor.agentId,
      runtime: actor.runtime,
      role: actor.role,
      projects: actor.projects,
    }));
    const expected = new Set(
      String(args["expected-actors"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const actual = new Set(actors.map((actor) => `${actor.agent_id}/${actor.runtime}`));
    const missing = [...expected].filter((actor) => !actual.has(actor));
    checks.push({ name: "tokens:actors", status: missing.length === 0 ? "ok" : "warn", actors, missing });
  } catch (error) {
    checks.push({ name: "tokens:actors", status: "fail", error: formatError(error) });
  }
}

function checkLatestBackup() {
  try {
    const latest = readdirSync(backupDir)
      .filter((name) => name.endsWith(".dump.gpg"))
      .map((name) => {
        const path = join(backupDir, name);
        return { path, stat: statSync(path) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    if (!latest) {
      checks.push({ name: "backup:latest", status: "fail", error: "No .dump.gpg backup found" });
      return;
    }
    checks.push({
      name: "backup:latest",
      status: "ok",
      file: latest.path,
      size_bytes: latest.stat.size,
      age_hours: Number(((Date.now() - latest.stat.mtimeMs) / 3_600_000).toFixed(2)),
    });
  } catch (error) {
    checks.push({ name: "backup:latest", status: "fail", error: formatError(error) });
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
