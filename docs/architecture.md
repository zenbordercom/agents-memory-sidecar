# Architecture

Agents Memory Sidecar has two local-facing layers:

```text
Agent CLI -> stdio MCP wrapper -> HTTP sidecar -> store
```

The store can be:

- fake JSON store for local development
- PostgreSQL for durable operation

## Components

- `src/server.ts`: stdio MCP wrapper
- `src/http-server.ts`: localhost HTTP sidecar
- `src/http-store.ts`: MCP wrapper client for the HTTP sidecar
- `src/pg-store.ts`: PostgreSQL implementation
- `src/store.ts`: fake JSON implementation
- `migrations/`: PostgreSQL schema

## Data Model

- `memory_items`: durable shared memories
- `project_contexts`: structured project facts
- `agent_observations`: short-lived process notes
- `audit_events`: write and authorization audit trail
- `memory_embeddings`: reserved for semantic search
- `schema_migrations`: migration tracking

## Request Flow

1. Agent calls an MCP tool.
2. The stdio wrapper validates tool arguments.
3. If `AGENT_MEMORY_BACKEND=http`, the wrapper forwards the request to the local HTTP sidecar.
4. The HTTP sidecar authenticates the bearer token.
5. Actor identity is derived from the token registry.
6. The store handles search/read/write.
7. Writes and authorization failures produce audit events.
