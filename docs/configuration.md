# Configuration

Configuration is environment-variable driven.

## Runtime Support

Agents Memory Sidecar supports Node.js 22 and later. CI verifies the current
22.x and 24.x release lines; PostgreSQL + pgvector integration runs on Node
24.x as the canonical database test environment.

## Related Docs

- [Architecture](architecture.md)
- [Security Model](security-model.md)
- [PostgreSQL Quickstart](postgres-quickstart.md)
- [Semantic And Hybrid Search](semantic-search.md)
- [Agent Integrations](agent-integrations.md)
- [Operations](operations.md)

## Core

```bash
AGENT_MEMORY_BACKEND=fake
AGENT_MEMORY_STORE_PATH=data/fake-store.json
```

```bash
AGENT_MEMORY_BACKEND=postgres
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=agent_memory
PGUSER=agent_memory_app
PGPASSWORD=change-me
```

Use TCP localhost for password-based local deployments. If you prefer Unix
sockets, configure PostgreSQL `pg_hba.conf` for the runtime user and omit
`PGPASSWORD` when using peer authentication.

## HTTP Sidecar

```bash
AGENT_MEMORY_HTTP_HOST=127.0.0.1
AGENT_MEMORY_HTTP_PORT=18790
AGENT_MEMORY_HTTP_TOKENS_FILE=/etc/agents-memory/http-tokens.json
```

### Authentication (fail closed)

`agents-memory-http` refuses to listen unless one of the following is true:

1. A valid token registry is configured via `AGENT_MEMORY_HTTP_TOKENS_FILE` or
   `AGENT_MEMORY_HTTP_TOKENS_JSON`, or
2. Explicit loopback demo mode is enabled with
   `AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1` **and** the bind host is
   loopback (`127.0.0.1`, `::1`, or `localhost`).

This is a breaking change from older releases that fell back to the process
environment actor when no registry was configured.

Startup validates every registry entry: a bearer-token key in SHA-256 hex
 digest form (64 hex characters — plaintext tokens are rejected), `agentId`,
`runtime`, role (`reader`|`writer`|`admin`), and a non-empty `projects` array.
Validation errors are actionable and never include full bearer token values.

`GET /healthz` remains unauthenticated so local liveness probes work without a
token. All other routes require a valid bearer token when a registry is
configured.

Unexpected handler failures return HTTP 500 with a stable public body:

```json
{ "error": "internal_error", "request_id": "..." }
```

Internal exception detail is written only to server logs with the same
`request_id`.

Malformed client requests use stable 4xx errors and do not include parser
detail: `invalid_json` (400), `invalid_request` (400),
`invalid_search_mode` (400), and `request_body_too_large` (413).

## Agent Actor

```bash
AGENT_MEMORY_AGENT_ID=codex-cli
AGENT_MEMORY_RUNTIME=codex
AGENT_MEMORY_ROLE=writer
AGENT_MEMORY_TENANT=default
AGENT_MEMORY_PROJECTS='*'
```

Roles:

- `reader`: read/search/context-get only
- `writer`: reader plus memory/observation writes
- `admin`: writer plus project context writes

## Token Registry

See `config/http-tokens.example.json`.

The registry maps SHA-256 hex digests of bearer tokens to actor metadata; the
plaintext tokens are never written to disk. Keep the real registry outside Git and restrict file permissions. Convert an existing plaintext file with
`node scripts/migrate-http-tokens.mjs --file <path>`.

Example entry shape:

```json
{
  "replace-with-random-token": {
    "tenant": "default",
    "agentId": "codex-cli",
    "runtime": "codex",
    "role": "writer",
    "projects": ["*"]
  }
}
```

### Loopback demo opt-in

For local demos without a registry (not for production):

```bash
AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1 \
AGENT_MEMORY_HTTP_HOST=127.0.0.1 \
npm run http:dev
```

Unauthenticated mode is rejected when the bind host is not loopback.

## Search Mode

Keyword search is the default:

```bash
AGENT_MEMORY_SEARCH_MODE=keyword
```

PostgreSQL deployments can use semantic or hybrid search when `memory_embeddings` contains vectors:

```bash
AGENT_MEMORY_SEARCH_MODE=hybrid
AGENT_MEMORY_EMBEDDING_MODEL=nomic-embed-text
AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`semantic` mode returns vector matches only. `hybrid` mode combines full-text rank with vector similarity. API callers may also pass `mode`, `embedding_model`, and `query_embedding` per search request. The accepted `mode` values are `keyword`, `semantic`, and `hybrid`; other values return `invalid_search_mode`.
