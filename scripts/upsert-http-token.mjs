#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { chownSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const file = args.file ?? "/etc/agents-memory/http-tokens.json";
const registry = readRegistry(file);

if (args.help === "true") {
  printHelp();
  process.exit(0);
}

if (args.list === "true") {
  console.log(JSON.stringify(listRegistry(registry), null, 2));
  process.exit(0);
}

if (args["remove-fingerprint"]) {
  const removed = removeFingerprint(registry, required(args, "remove-fingerprint"));
  writeRegistry(file, registry);
  console.log(JSON.stringify({ removed }, null, 2));
  process.exit(0);
}

const token = args.token ?? randomBytes(32).toString("base64url");
const actor = validateActor({
  tenant: args.tenant ?? "default",
  agentId: required(args, "agent-id"),
  runtime: required(args, "runtime"),
  role: args.role ?? "writer",
  projects: splitProjects(args.projects ?? "*"),
});

if (args["keep-existing"] !== "true") {
  for (const [existingToken, existingActor] of Object.entries(registry)) {
    if (existingActor?.agentId === actor.agentId && existingActor?.runtime === actor.runtime) {
      delete registry[existingToken];
    }
  }
}

registry[tokenDigest(token)] = actor;
writeRegistry(file, registry);

const tokenFingerprint = fingerprint(token);
console.log(JSON.stringify({ fingerprint: tokenFingerprint, actor }, null, 2));

if (args["print-token"] === "true") {
  console.error("Refusing to print the full token by default. Read it from the registry file with sudo when needed.");
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

function required(values, key) {
  const value = values[key];
  if (!value || value === "true") {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function splitProjects(value) {
  return value.split(",").map((project) => project.trim()).filter(Boolean);
}

function validateActor(actor) {
  for (const key of ["tenant", "agentId", "runtime", "role"]) {
    if (typeof actor[key] !== "string" || actor[key].length === 0) {
      throw new Error(`Invalid actor field: ${key}`);
    }
  }
  if (!["reader", "writer", "admin"].includes(actor.role)) {
    throw new Error("Invalid role: expected reader, writer, or admin");
  }
  if (!Array.isArray(actor.projects) || actor.projects.length === 0) {
    throw new Error("Invalid projects: expected at least one project");
  }
  return actor;
}

function listRegistry(registry) {
  return Object.entries(registry).map(([token, actor]) => ({
    fingerprint: fingerprint(token),
    actor,
  }));
}

function removeFingerprint(registry, value) {
  const removed = [];
  for (const [token, actor] of Object.entries(registry)) {
    if (fingerprint(token) === value) {
      delete registry[token];
      removed.push({ fingerprint: value, actor });
    }
  }
  if (removed.length === 0) {
    throw new Error(`No token matched fingerprint: ${value}`);
  }
  return removed;
}

function fingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function readRegistry(path) {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content ? JSON.parse(content) : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function writeRegistry(path, value) {
  const temp = `${path}.tmp`;
  const existingStat = getExistingStat(path);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  if (existingStat) {
    chownSync(temp, existingStat.uid, existingStat.gid);
  }
  renameSync(temp, path);
}

function getExistingStat(path) {
  try {
    return statSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function printHelp() {
  console.log(`Usage:
  upsert-http-token.mjs --list [--file PATH]
  upsert-http-token.mjs --remove-fingerprint FINGERPRINT [--file PATH]
  upsert-http-token.mjs --agent-id ID --runtime RUNTIME [--role writer] [--tenant default] [--projects '*'] [--keep-existing] [--file PATH]

Defaults:
  --file /etc/agents-memory/http-tokens.json
  --role writer
  --tenant default
  --projects '*'

The script prints token fingerprints only. It never prints full bearer tokens.

The registry file stores SHA-256 hex digests of bearer tokens as keys, never
the plaintext tokens themselves.`);
}
