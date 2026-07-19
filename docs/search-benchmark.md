# Search Benchmark

This benchmark provides a small, versioned regression signal for retrieval
behavior. It is not a statistical evaluation and must not be used to claim
general search quality.

## Fixture

[`fixtures/search-relevance.v1.json`](../fixtures/search-relevance.v1.json)
contains only non-sensitive synthetic operational memories, three-dimensional
fixture vectors, and explicit relevance judgments. A fixture update is a
behavioral change and must be reviewed with its expected-result rationale.

## Run The Keyword Baseline

Build first, then run the fake-store baseline:

```bash
npm run build
npm run search:benchmark
```

The report includes per-query `recall_at_5`, reciprocal rank, latency, requested
and actual mode, embedding metadata, and fallback information. The fake backend
has no vector support, so it intentionally reports hybrid fallback to keyword.

## Run PostgreSQL Semantic And Hybrid Measurements

Use a migrated PostgreSQL 16 + pgvector database:

```bash
AGENT_MEMORY_BACKEND=postgres \
PGHOST=127.0.0.1 \
PGDATABASE=agents_memory \
PGUSER=postgres \
PGPASSWORD=postgres \
npm run search:benchmark
```

The command creates a random `benchmark-*` project, inserts fixture embeddings
under `fixture-3d-v1`, reports keyword, semantic, hybrid, and hybrid-fallback
measurements, then removes only that temporary project scope.

The report records `dimensions`, `embedding_model`, requested and actual search
mode, and `fallback`. A fallback is expected only when an embedding model or
query embedding is unavailable; semantic mode remains an explicit error in that
case.

## Interpreting Regressions

- A relevant fixture not returned in the top five is a regression candidate.
- Changed reciprocal rank indicates ranking movement and needs review.
- Latency is a local diagnostic, not a cross-machine performance comparison.
- If a fixture must change, update its version rather than silently rewriting
  historic judgments.
