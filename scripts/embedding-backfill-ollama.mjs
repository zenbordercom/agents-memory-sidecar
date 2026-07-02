#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const args = parseArgs(process.argv.slice(2));
const envFile = args["env-file"] ?? "/etc/agents-memory/sidecar.env";
const tenant = args.tenant ?? "default";
const project = args.project;
const model = required(args.model, "--model is required");
const limit = Number(args.limit ?? 10);
const batchSize = Number(args["batch-size"] ?? 4);
const dimensions = args.dimensions ? Number(args.dimensions) : undefined;
const timeoutMs = Number(args["timeout-ms"] ?? 120000);
const baseUrl = (args["base-url"] ?? process.env.AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const write = args.write === "true";
const pretty = args.pretty === "true";

if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit must be an integer from 1 to 200");
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error("--batch-size must be an integer from 1 to 32");
if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions < 1)) {
  throw new Error("--dimensions must be a positive integer");
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms must be an integer >= 1000");

loadEnvFile(envFile);

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

try {
  const report = await run();
  console.log(JSON.stringify(report, null, pretty ? 2 : 0));
} finally {
  await pool.end();
}

async function run() {
  const candidates = await loadCandidates();

  if (!write) {
    return {
      status: "dry-run",
      model,
      base_url: baseUrl,
      dimensions: dimensions ?? null,
      tenant,
      project: project ?? null,
      candidate_count: candidates.length,
      candidates: candidates.map(({ body: _body, ...candidate }) => candidate),
      note: "Dry run only. No Ollama request was made and no vector was written. Add --write to call /api/embed and upsert memory_embeddings.",
    };
  }

  let written = 0;
  let observedDimensions = null;

  for (let index = 0; index < candidates.length; index += batchSize) {
    const batch = candidates.slice(index, index + batchSize);
    const embeddings = await embed(batch.map(formatEmbeddingInput));
    if (embeddings.length !== batch.length) {
      throw new Error(`Ollama returned ${embeddings.length} embeddings for ${batch.length} inputs`);
    }

    for (let i = 0; i < batch.length; i += 1) {
      const embedding = embeddings[i];
      if (!Array.isArray(embedding) || embedding.length === 0) throw new Error("Ollama returned an empty embedding");
      observedDimensions ??= embedding.length;
      if (embedding.length !== observedDimensions) {
        throw new Error(`Embedding dimension mismatch: expected ${observedDimensions}, got ${embedding.length}`);
      }
      await pool.query(
        `
        INSERT INTO memory_embeddings (memory_id, embedding_model, embedding, content_hash)
        VALUES ($1, $2, $3::vector, $4)
        ON CONFLICT (memory_id, embedding_model)
        DO UPDATE SET embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash, created_at = now()
        `,
        [batch[i].id, model, JSON.stringify(embedding), batch[i].content_hash],
      );
      written += 1;
    }
  }

  return {
    status: "ok",
    model,
    base_url: baseUrl,
    dimensions: dimensions ?? null,
    tenant,
    project: project ?? null,
    candidate_count: candidates.length,
    written,
    observed_dimensions: observedDimensions,
    note: "Wrote vectors to memory_embeddings only. memory_search ranking is unchanged.",
  };
}

async function loadCandidates() {
  const params = [tenant, model, limit];
  const filters = ["mi.tenant = $1", "mi.deleted_at IS NULL", "mi.content_hash IS NOT NULL"];

  if (project) {
    params.push(project);
    filters.push(`mi.project = $${params.length}`);
  }

  const result = await pool.query(
    `
    SELECT mi.id, mi.project, mi.namespace, mi.kind, mi.title, mi.summary, mi.body, mi.content_hash, mi.created_at,
           CASE
             WHEN me.memory_id IS NULL THEN 'missing'
             WHEN me.content_hash IS DISTINCT FROM mi.content_hash THEN 'stale'
             ELSE 'current'
           END AS embedding_status
    FROM memory_items mi
    LEFT JOIN memory_embeddings me
      ON me.memory_id = mi.id
     AND me.embedding_model = $2
    WHERE ${filters.join(" AND ")}
      AND (me.memory_id IS NULL OR me.content_hash IS DISTINCT FROM mi.content_hash)
    ORDER BY mi.created_at DESC
    LIMIT $3
    `,
    params,
  );

  return result.rows;
}

async function embed(inputs) {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      input: inputs,
      truncate: true,
      ...(dimensions ? { dimensions } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama /api/embed failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  if (!Array.isArray(json.embeddings)) throw new Error("Ollama response did not include embeddings[]");
  return json.embeddings;
}

function formatEmbeddingInput(item) {
  return [item.title, item.summary, item.body].filter(Boolean).join("\n\n");
}

function required(value, message) {
  if (!value) throw new Error(message);
  return value;
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
