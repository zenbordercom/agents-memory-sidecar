#!/usr/bin/env node
// One-shot migration: convert a plaintext token registry (keys = bearer
// tokens) to the hashed format (keys = SHA-256 hex digests of the tokens).
//
// Idempotent: keys that are already 64-char lowercase hex digests are
// preserved as-is, so the script can be re-run safely. A timestamped backup
// of the original file is written next to it before any change.
//
// Usage: node scripts/migrate-http-tokens.mjs [--file /etc/agents-memory/http-tokens.json]
import { createHash } from "node:crypto";
import { chownSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const file = args.file ?? "/etc/agents-memory/http-tokens.json";

if (!existsSync(file)) {
  console.error(`Registry file not found: ${file}`);
  process.exit(1);
}

const raw = readFileSync(file, "utf8");
let registry;
try {
  registry = JSON.parse(raw);
} catch (error) {
  console.error(`Registry file is not valid JSON: ${error.message}`);
  process.exit(1);
}
if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
  console.error("Registry must be a JSON object.");
  process.exit(1);
}

const digestPattern = /^[0-9a-f]{64}$/;
const migrated = {};
let converted = 0;
let alreadyHashed = 0;

for (const [key, value] of Object.entries(registry)) {
  if (digestPattern.test(key.toLowerCase())) {
    migrated[key.toLowerCase()] = value;
    alreadyHashed += 1;
    continue;
  }
  if (typeof key !== "string" || key.length === 0) {
    console.error("Found an empty registry key; refusing to migrate. Fix the file manually.");
    process.exit(1);
  }
  migrated[createHash("sha256").update(key, "utf8").digest("hex")] = value;
  converted += 1;
}

if (converted === 0) {
  console.log(JSON.stringify({ file, converted, alreadyHashed, changed: false }, null, 2));
  process.exit(0);
}

const backup = `${file}.plaintext-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(file, backup);

const temp = `${file}.tmp`;
const stat = statSync(file);
writeFileSync(temp, `${JSON.stringify(migrated, null, 2)}\n`, { mode: stat.mode & 0o777 });
chownSync(temp, stat.uid, stat.gid);
renameSync(temp, file);

console.log(JSON.stringify({ file, backup, converted, alreadyHashed, changed: true }, null, 2));
console.error("Plaintext tokens were removed. Distribute tokens to clients from your existing records; they are not recoverable from the file.");
if (alreadyHashed > 0) {
  console.error(`Note: ${alreadyHashed} key(s) already looked like SHA-256 digests and were preserved as-is. If one of those was actually a plaintext token that happens to be 64 hex chars, it will no longer authenticate - re-register it with scripts/upsert-http-token.mjs.`);
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
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
