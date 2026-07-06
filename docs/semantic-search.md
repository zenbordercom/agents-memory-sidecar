# Semantic And Hybrid Search

Agents Memory Sidecar defaults to keyword search. PostgreSQL deployments can use
pgvector-backed semantic or hybrid search after memory embeddings are backfilled.

Use this guide after [PostgreSQL Quickstart](postgres-quickstart.md) is working.

## Related Docs

- [Configuration](configuration.md)
- [PostgreSQL Quickstart](postgres-quickstart.md)
- [30-Minute Durable Deployment Transcript](30-minute-durable-deployment-transcript.md)
- [Limitations](limitations.md)

## Modes

- `keyword`: PostgreSQL full-text search only. This is the default and does not
  require embeddings or Ollama.
- `semantic`: vector search only. This requires stored embeddings and a query
  embedding.
- `hybrid`: combines full-text rank with vector similarity. This is the
  recommended semantic mode once embeddings exist.

## Requirements

- PostgreSQL backend
- `vector` extension installed
- migrated `memory_embeddings` table
- at least one durable memory item
- an embedding model for backfill and query embeddings

The first documented embedding provider is Ollama. The first example model is
`nomic-embed-text`.

## Ollama Setup

Start Ollama and pull the model:

```bash
ollama pull nomic-embed-text
```

Set the embedding environment:

```bash
export AGENT_MEMORY_EMBEDDING_MODEL=nomic-embed-text
export AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

If you use a different model, use the same model name for readiness reports,
backfill, and search.

## Readiness Report

The readiness report is read-only. It does not call the embedding model, write
vectors, change search ranking, or print memory bodies.

```bash
node scripts/embedding-readiness-report.mjs \
  --model nomic-embed-text \
  --pretty
```

Useful fields:

- `active_memory_items`: durable memory rows that can be embedded
- `embedding_rows`: total rows in `memory_embeddings`
- `coverage`: per-model row counts and dimensions
- `missing_or_stale_for_requested_model`: rows that need backfill

## Dry-Run Backfill

Dry-run mode finds candidates but does not call Ollama and does not write
vectors:

```bash
node scripts/embedding-backfill-ollama.mjs \
  --model nomic-embed-text \
  --limit 20 \
  --pretty
```

Scope by project when needed:

```bash
node scripts/embedding-backfill-ollama.mjs \
  --model nomic-embed-text \
  --project demo-app \
  --limit 20 \
  --pretty
```

## Write Backfill

Write mode calls Ollama `/api/embed` and upserts `memory_embeddings`:

```bash
node scripts/embedding-backfill-ollama.mjs \
  --model nomic-embed-text \
  --project demo-app \
  --limit 50 \
  --batch-size 4 \
  --write \
  --pretty
```

Run the readiness report again after backfill:

```bash
node scripts/embedding-readiness-report.mjs \
  --model nomic-embed-text \
  --pretty
```

Expected state for a backfilled model:

```text
embedding_rows > 0
coverage[].embedding_model includes nomic-embed-text
coverage[].stale_rows = 0
```

## Search With Embeddings

Use hybrid search as the default semantic mode:

```bash
AGENT_MEMORY_BACKEND=postgres \
AGENT_MEMORY_SEARCH_MODE=hybrid \
AGENT_MEMORY_EMBEDDING_MODEL=nomic-embed-text \
AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"deployment convention",
  "limit":5
}'
```

You can also pass mode and embedding data per request. This is useful for tests
or clients that generate query embeddings themselves. The `query_embedding`
dimension must match stored rows for the selected `embedding_model`.

```bash
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"deployment convention",
  "limit":5,
  "mode":"hybrid",
  "embedding_model":"example-3d-model",
  "query_embedding":[0.1,0.2,0.3]
}'
```

Hybrid and semantic results include metadata such as:

```text
search_mode
embedding_model
keyword_score
semantic_score
```

`semantic_score` appears when a vector match is available. `keyword_score`
appears for hybrid search.

## Fallback Behavior

- `keyword` mode never requires embeddings.
- `semantic` mode requires `embedding_model` and a query embedding, either
  supplied directly or generated through Ollama from
  `AGENT_MEMORY_EMBEDDING_MODEL`.
- `hybrid` mode falls back to keyword search when no model or query embedding is
  configured.
- If a model is configured and Ollama fails while generating the query
  embedding, the search returns an error instead of silently hiding the problem.
- Stored embeddings with a different vector dimension are ignored for that
  query.

## Troubleshooting

- `semantic search requires embedding_model`: set
  `AGENT_MEMORY_EMBEDDING_MODEL` or pass `embedding_model`.
- `Ollama /api/embed failed`: confirm Ollama is running and the model is pulled.
- Empty semantic results: run the readiness report and backfill missing or stale
  rows.
- Dimension mismatch: re-backfill with one model consistently, or use a distinct
  `embedding_model` name for each model/dimension pair.
- Unexpected keyword results in hybrid mode: confirm `search_mode=hybrid` and
  that returned rows include `semantic_score`.
