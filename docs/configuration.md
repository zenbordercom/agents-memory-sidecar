# Configuration

Configuration is environment-variable driven.

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
PGDATABASE=agents_memory
PGUSER=agents_memory_app
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

The registry maps full bearer tokens to actor metadata. Keep the real registry outside Git and restrict file permissions.

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

`semantic` mode returns vector matches only. `hybrid` mode combines full-text rank with vector similarity. API callers may also pass `mode`, `embedding_model`, and `query_embedding` per search request.
