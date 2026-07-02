# Agents Memory Sidecar

Local-first shared memory for MCP-capable AI agents.

Agents Memory Sidecar lets tools such as Codex, Claude Code, Grok, agy, Pi, and other MCP clients share operational memory through one local sidecar. It is designed for coding agents that need to search prior context before changing a project and store durable non-secret facts after work is validated.

```text
Agent CLI -> stdio MCP wrapper -> localhost HTTP sidecar -> PostgreSQL + pgvector
```

The HTTP server is intended to listen on `127.0.0.1` only. Do not expose it directly to the public internet.

## Features

- MCP tools for searching, reading, and writing shared memory
- Project context storage for stable paths, services, ports, and conventions
- Short-lived agent observations with TTL
- HTTP sidecar with bearer-token authentication
- Actor identity derived from token registry, not model-provided fields
- PostgreSQL persistence with pgvector installed for future semantic search
- Secret rejection for common token/private-key patterns
- Audit events for writes, permission denials, unauthorized calls, and pruning
- Fake JSON store for local development and smoke tests

## MCP Tools

- `memory_search`
- `memory_get`
- `project_context_get`
- `memory_add`
- `agent_observation_add`
- `project_context_set` (admin-only)

## Quick Start

```bash
npm install
npm run build
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
```

Run the stdio MCP wrapper with the fake store:

```bash
AGENT_MEMORY_AGENT_ID=local-agent \
AGENT_MEMORY_RUNTIME=local \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
npm run dev
```

Run the HTTP sidecar locally with PostgreSQL after configuring the database:

```bash
AGENT_MEMORY_BACKEND=postgres \
AGENT_MEMORY_HTTP_HOST=127.0.0.1 \
AGENT_MEMORY_HTTP_PORT=18790 \
npm run http:dev
```

Use the fallback CLI:

```bash
node dist/cli.js memory_search '{"tenant":"default","project":"demo-app","query":"deployment","limit":5}'
```

## PostgreSQL

Create a PostgreSQL database and install migrations:

```bash
createdb agents_memory
AGENT_MEMORY_BACKEND=postgres \
PGDATABASE=agents_memory \
npm run db:migrate
```

For production, use a restricted application role and store connection settings outside the repository. See [Configuration](docs/configuration.md).

## Agent Setup

The recommended client pattern is:

1. Store the bearer token in a private env file.
2. Create a small launcher script that sources that env file.
3. Point the agent's MCP config at the launcher.

See [Agent Integrations](docs/agent-integrations.md) and `integrations/*/README.md`.

## Security Defaults

- Bind the HTTP sidecar to `127.0.0.1`.
- Keep full bearer tokens out of Git, chat, logs, and docs.
- Use separate tokens per agent.
- Give normal agents `writer`, not `admin`.
- Store stable facts, not secrets or raw `.env` files.
- Treat model-provided actor fields as untrusted.

See [Security Model](docs/security-model.md).

## Production Operations

Optional scripts and systemd unit examples are included for local Linux deployments. They are templates, not a universal installer. Review paths, users, groups, database roles, and backup passphrase handling before use.

See [Operations](docs/operations.md) and [Backup And Restore](docs/backup-restore.md).

## Limitations

- V1 search is keyword/full-text search. Semantic ranking is not enabled by default.
- The project does not replace an agent's internal conversation memory.
- The sidecar is local-first and not designed as a public multi-tenant SaaS API.
- Fresh install automation is intentionally minimal in this version.

## License

Apache-2.0.
