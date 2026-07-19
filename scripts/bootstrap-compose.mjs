#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? ".local/agents-memory-compose");
const postgresEnv = join(directory, "postgres.env");
const tokensFile = join(directory, "http-tokens.json");
const agentId = "compose-local-cli";
const runtime = "compose";

mkdirSync(directory, { recursive: true, mode: 0o700 });

if (!existsSync(postgresEnv)) {
  const password = randomBytes(24).toString("base64url");
  writeFileSync(
    postgresEnv,
    `POSTGRES_DB=agents_memory\nPOSTGRES_USER=agents_memory\nPOSTGRES_PASSWORD=${password}\nPGDATABASE=agents_memory\nPGUSER=agents_memory\nPGPASSWORD=${password}\n`,
    { mode: 0o600 },
  );
  chmodSync(postgresEnv, 0o600);
}

let fingerprint;
if (existsSync(tokensFile)) {
  const registry = JSON.parse(readFileSync(tokensFile, "utf8"));
  const entry = Object.entries(registry).find(
    ([, actor]) => actor?.agentId === agentId && actor?.runtime === runtime,
  );
  if (entry) fingerprint = fingerprintToken(entry[0]);
}

if (!fingerprint) {
  execFileSync(
    process.execPath,
    [
      "scripts/upsert-http-token.mjs",
      "--file",
      tokensFile,
      "--agent-id",
      agentId,
      "--runtime",
      runtime,
      "--role",
      "writer",
      "--projects",
      "*",
    ],
    { stdio: "inherit" },
  );
  const registry = JSON.parse(readFileSync(tokensFile, "utf8"));
  const entry = Object.entries(registry).find(
    ([, actor]) => actor?.agentId === agentId && actor?.runtime === runtime,
  );
  if (!entry) throw new Error("Token bootstrap did not create the expected compose actor");
  fingerprint = fingerprintToken(entry[0]);
}

chmodSync(tokensFile, 0o600);
console.log(JSON.stringify({ directory, postgres_env: postgresEnv, token_fingerprint: fingerprint }, null, 2));

function fingerprintToken(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
