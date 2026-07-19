# Docker Compose Quickstart

Use this path for a durable local PostgreSQL + pgvector deployment without
installing PostgreSQL directly on the host. It complements, rather than
replaces, the native PostgreSQL and systemd paths in
[PostgreSQL Quickstart](postgres-quickstart.md) and [Operations](operations.md).

## Prerequisites

- Docker Engine with the Compose plugin
- Node.js 22 or later, used only for private local configuration bootstrap and
  optional smoke validation

The stack binds PostgreSQL and the HTTP sidecar to loopback only:

```text
127.0.0.1:5432  PostgreSQL
127.0.0.1:18790 HTTP sidecar
```

## Bootstrap Private Local Configuration

From the repository root:

```bash
npm run compose:bootstrap
```

This creates `.local/agents-memory-compose/` with mode `0700`, a PostgreSQL
environment file, and a token registry. It prints only the token fingerprint.
The directory is ignored by Git and excluded from Docker build context.

Do not commit, share, or copy these files into issue reports.

## Start The Stack

```bash
docker compose up --build --detach --wait
docker compose ps
curl --fail-with-body http://127.0.0.1:18790/healthz
```

The sidecar waits for PostgreSQL health, runs migrations explicitly, and then
starts the fail-closed HTTP server. A migration failure leaves the `sidecar`
container unhealthy and its logs show the failure:

```bash
docker compose logs sidecar
```

## Write And Search

Load the local token into a shell variable without printing it:

```bash
export AGENT_MEMORY_HTTP_BEARER_TOKEN="$(
  node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('.local/agents-memory-compose/http-tokens.json','utf8'));const e=Object.entries(r).find(([,a])=>a.agentId==='compose-local-cli'&&a.runtime==='compose');if(!e) throw new Error('compose token missing');process.stdout.write(e[0])"
)"
```

Then use the HTTP CLI backend:

```bash
AGENT_MEMORY_BACKEND=http \
AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790 \
AGENT_MEMORY_AGENT_ID=compose-local-cli \
AGENT_MEMORY_RUNTIME=compose \
AGENT_MEMORY_ROLE=writer \
AGENT_MEMORY_PROJECTS='*' \
node dist/cli.js memory_add '{
  "tenant":"default",
  "project":"compose-demo",
  "namespace":"ops",
  "kind":"note",
  "title":"Compose memory",
  "body":"PostgreSQL data persists in the Compose named volume.",
  "source_type":"manual"
}'
```

## Restart And Persistence Check

The named `postgres_data` volume keeps memories across normal restarts:

```bash
docker compose restart sidecar
docker compose up --detach --wait sidecar
```

Run the complete clean-start and restart-persistence validation:

```bash
npm run compose:smoke
```

The smoke creates an isolated Compose project, writes a memory, restarts the
sidecar, confirms the memory remains searchable, then removes only that
isolated project's containers and volume. Add `-- --keep` to keep it for
inspection.

## Data Removal And Backup

`docker compose down` stops containers but preserves `postgres_data`.
`docker compose down --volumes` deletes all local Compose database data.
Treat that action as irreversible unless you have an external PostgreSQL backup.

For native operations and backup procedures, use
[Backup And Restore](backup-restore.md). The native systemd deployment remains
the supported option when you need host-managed backup timers and service
hardening.
