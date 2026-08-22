# Agents Memory Sidecar

Local-first shared memory for MCP-capable AI agents.

> **Breaking change in 0.4.0:** token registry files now store **SHA-256 hex digests**
> of bearer tokens as keys — plaintext tokens are rejected at startup. Convert an
> existing file with `node scripts/migrate-http-tokens.mjs --file <path>`, or generate
> fresh tokens with `scripts/upsert-http-token.mjs`. See the CHANGELOG for details.

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
- PostgreSQL persistence with pgvector-backed semantic and hybrid search
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

## Search Modes

Search defaults to keyword/full-text mode. PostgreSQL deployments can enable `semantic` or `hybrid` mode after backfilling `memory_embeddings`; see [Configuration](docs/configuration.md) and [Semantic And Hybrid Search](docs/semantic-search.md).

## Guides

- [Architecture](docs/architecture.md)
- [5-Minute Demo Transcript](docs/5-minute-demo-transcript.md)
- [PostgreSQL Quickstart](docs/postgres-quickstart.md)
- [Docker Compose Quickstart](docs/compose-quickstart.md)
- [30-Minute Durable Deployment Transcript](docs/30-minute-durable-deployment-transcript.md)
- [Semantic And Hybrid Search](docs/semantic-search.md)
- [Search Benchmark](docs/search-benchmark.md)
- [Memory Governance](docs/memory-governance.md)
- [Agent Integrations](docs/agent-integrations.md)
- [Operations](docs/operations.md)
- [Backup And Restore](docs/backup-restore.md)
- [Security Model](docs/security-model.md)
- [Release Checklist](docs/release-checklist.md)
- [Support Matrix](docs/support-matrix.md)
- [Good First Issues](docs/good-first-issues.md)
- [v0.2.1 Release Evidence](docs/v0.2.1-release-evidence.md)
- [v0.3.1 Release Evidence](docs/v0.3.1-release-evidence.md)
- [v0.3.0 CI Evidence](docs/v0.3.0-ci-evidence.md)
- [v0.3.0 Construction Plan](docs/v0.3.0-construction-plan.md)
- [v0.3.2 P0 Task List](docs/v0.3.2-p0-task-list.md)

## Quick Start

### Install From Source

```bash
git clone https://github.com/zenbordercom/agents-memory-sidecar.git
cd agents-memory-sidecar
npm install
npm run build
```

Validate the checkout and build output:

```bash
node scripts/check-installation.mjs --profile quickstart --pretty
```

### Demo Mode

Demo mode uses the fake JSON store and does not require PostgreSQL, systemd, or
production config files:

```bash
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
```

Use the fallback CLI against the fake store:

```bash
AGENT_MEMORY_AGENT_ID=local-cli \
AGENT_MEMORY_RUNTIME=local \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
node dist/cli.js memory_add '{
  "tenant":"default",
  "project":"demo-app",
  "namespace":"ops",
  "kind":"note",
  "title":"Demo memory",
  "body":"Agents Memory Sidecar demo mode is running with the fake store.",
  "source_type":"manual"
}'
```

Search it:

```bash
AGENT_MEMORY_AGENT_ID=local-cli \
AGENT_MEMORY_RUNTIME=local \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"demo mode",
  "limit":5
}'
```

### Local HTTP Sidecar Mode

HTTP authentication fails closed. `agents-memory-http` will not listen unless a
valid token registry is configured (`AGENT_MEMORY_HTTP_TOKENS_FILE` or
`AGENT_MEMORY_HTTP_TOKENS_JSON`). For deliberate loopback demos only, set
`AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1` with a loopback bind host.
`GET /healthz` stays unauthenticated for local liveness checks.

Create a private local token registry. Generate the bearer token yourself and
pass it to the upsert helper — the registry stores only its SHA-256 digest:

```bash
mkdir -p .local/agents-memory
export AGENT_MEMORY_HTTP_BEARER_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
node scripts/upsert-http-token.mjs \
  --file .local/agents-memory/http-tokens.json \
  --token "$AGENT_MEMORY_HTTP_BEARER_TOKEN" \
  --agent-id local-cli \
  --runtime local \
  --role writer \
  --projects '*'
```

The upsert script prints a fingerprint only and never echoes the token. Keep
`AGENT_MEMORY_HTTP_BEARER_TOKEN` exported in whichever shell calls the CLI
below.

Start the HTTP sidecar in one terminal:

```bash
AGENT_MEMORY_HTTP_TOKENS_FILE="$PWD/.local/agents-memory/http-tokens.json" \
AGENT_MEMORY_HTTP_HOST=127.0.0.1 \
AGENT_MEMORY_HTTP_PORT=18790 \
npm run http:dev
```

In another terminal, call it through the CLI HTTP backend (re-export
`AGENT_MEMORY_HTTP_BEARER_TOKEN` with the value you generated above if you
opened a new shell):

```bash

AGENT_MEMORY_BACKEND=http \
AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790 \
AGENT_MEMORY_AGENT_ID=local-cli \
AGENT_MEMORY_RUNTIME=local \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
node dist/cli.js memory_add '{
  "tenant":"default",
  "project":"demo-app",
  "namespace":"ops",
  "kind":"note",
  "title":"HTTP sidecar demo",
  "body":"The local HTTP sidecar accepts bearer-token memory writes.",
  "source_type":"manual"
}'
```

Search it:

```bash
AGENT_MEMORY_BACKEND=http \
AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790 \
AGENT_MEMORY_AGENT_ID=local-cli \
AGENT_MEMORY_RUNTIME=local \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"HTTP sidecar",
  "limit":5
}'
```

### Durable PostgreSQL Mode

Use PostgreSQL when you want durable shared memory:

```bash
AGENT_MEMORY_BACKEND=postgres \
PGDATABASE=agent_memory \
npm run db:migrate
```

Then run the PostgreSQL smoke test:

```bash
npm run postgres:smoke
```

See [PostgreSQL Quickstart](docs/postgres-quickstart.md) for a complete local
database setup.

## Installation Options

Install the current npm release:

```bash
npm install -g agents-memory-sidecar@0.3.1
```

Verify the registry version and dist-tag:

```bash
npm view agents-memory-sidecar version
npm view agents-memory-sidecar dist-tags.latest
```

Both commands should print `0.3.1`.

You can also install the matching GitHub release tag:

```bash
npm install -g github:zenbordercom/agents-memory-sidecar#v0.3.1
```

Or install the GitHub release tarball:

```bash
npm install -g https://github.com/zenbordercom/agents-memory-sidecar/releases/download/v0.3.1/agents-memory-sidecar-0.3.1.tgz
```

The CLI entry points are:

```bash
agents-memory --help
agents-memory-mcp
agents-memory-http
```

- `agents-memory`: JSON CLI for direct commands and fallback automation.
- `agents-memory-mcp`: stdio MCP wrapper for agent clients.
- `agents-memory-http`: local HTTP sidecar.

## Quick Start Troubleshooting

- Missing `dist/*.js`: run `npm run build`.
- Missing token registry / startup refused: create a registry with
  `scripts/upsert-http-token.mjs`, set `AGENT_MEMORY_HTTP_TOKENS_FILE`, and
  restart. Tokenless mode requires
  `AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1` on loopback only.
- HTTP connection refused: start `agents-memory-http` or `npm run http:dev`,
  then run `node scripts/check-installation.mjs --profile quickstart --check-http --expected-backend fake --pretty`.
- `unauthorized`: send `Authorization: Bearer <token>` from the registry.
- `permission_denied`: check that the bearer token actor has the required role
  and project access.

## Agent Setup

The recommended client pattern is:

1. Store the bearer token in a private env file.
2. Create a small launcher script that sources that env file.
3. Point the agent's MCP config at the launcher.

See [Agent Integrations](docs/agent-integrations.md) and `integrations/*/README.md`.

## Security Defaults

- Bind the HTTP sidecar to `127.0.0.1`.
- Require a token registry; do not rely on fail-open environment actor fallback.
- Keep full bearer tokens out of Git, chat, logs, and docs.
- Use separate tokens per agent.
- Give normal agents `writer`, not `admin`.
- Store stable facts, not secrets or raw `.env` files.
- Treat model-provided actor fields as untrusted.

See [Security Model](docs/security-model.md).

## Production Operations

Optional scripts and systemd unit examples are included for local Linux deployments. Review paths, users, groups, database roles, and backup passphrase handling before use.

```bash
sudo scripts/install-local.sh
```

See [Operations](docs/operations.md) and [Backup And Restore](docs/backup-restore.md).

## Limitations

- Search defaults to keyword/full-text mode. Semantic and hybrid search require stored embeddings and an embedding model or explicit query embedding.
- The project does not replace an agent's internal conversation memory.
- The sidecar is local-first and not designed as a public multi-tenant SaaS API.
- Fresh install automation is intentionally minimal in this version.

## What This Is Not

- Not a hosted SaaS API or public internet service.
- Not an agent scheduler or orchestration framework.
- Not a secret manager.
- Not full conversation memory.
- Not a replacement for each agent's native session state.

## License

Apache-2.0.
