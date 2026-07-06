# PostgreSQL Quickstart

This guide sets up a durable local PostgreSQL backend for Agents Memory Sidecar.
Use the fake store for a faster demo path; use this guide when you want memory
items, project context, observations, audit events, and embeddings to persist.

The HTTP sidecar should still listen on `127.0.0.1`.

## Related Docs

- [Configuration](configuration.md)
- [Security Model](security-model.md)
- [Operations](operations.md)
- [Backup And Restore](backup-restore.md)
- [Semantic And Hybrid Search](semantic-search.md)
- [30-Minute Durable Deployment Transcript](30-minute-durable-deployment-transcript.md)

## Prerequisites

- Node.js and npm
- A built checkout:

```bash
npm install
npm run build
```

- PostgreSQL with the `vector` extension available

The CI path uses the `pgvector/pgvector:pg16` container image. You can use a
system PostgreSQL installation instead if `CREATE EXTENSION vector` works in the
target database.

## Option A: Local Docker PostgreSQL

Start a disposable local PostgreSQL with pgvector:

```bash
docker run --rm --name agents-memory-pg \
  -e POSTGRES_DB=agents_memory \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

In another terminal:

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=agents_memory
export PGUSER=postgres
export PGPASSWORD=postgres
export AGENT_MEMORY_BACKEND=postgres
```

## Option B: Existing Local PostgreSQL

Create an application role and database. Choose your own password.

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agents_memory_app') THEN
    CREATE ROLE agents_memory_app LOGIN PASSWORD 'change-me';
  END IF;
END
$$;
SELECT 'CREATE DATABASE agents_memory OWNER agents_memory_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agents_memory')\gexec
\c agents_memory
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

Set the application connection environment:

```bash
export PGHOST=/var/run/postgresql
export PGDATABASE=agents_memory
export PGUSER=agents_memory_app
export PGPASSWORD=change-me
export AGENT_MEMORY_BACKEND=postgres
```

For production, store these values outside the repository, for example in
`/etc/agents-memory/sidecar.env` with restricted file permissions.

## Run Migrations

From the repository root:

```bash
AGENT_MEMORY_BACKEND=postgres npm run db:migrate
```

Verify the PostgreSQL search path, pgvector schema, keyword search, semantic
search, and hybrid search:

```bash
npm run postgres:smoke
```

## Create A Local Token Registry

The HTTP sidecar uses bearer tokens to derive actor identity. Create a local
registry under `.local/` for development:

```bash
mkdir -p .local/agents-memory
node scripts/upsert-http-token.mjs \
  --file .local/agents-memory/http-tokens.json \
  --agent-id local-cli \
  --runtime local \
  --role writer \
  --projects '*'
```

Load the generated token into the current shell from the private registry file:

```bash
export AGENT_MEMORY_HTTP_BEARER_TOKEN="$(
  node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('.local/agents-memory/http-tokens.json','utf8'));console.log(Object.keys(r)[0])"
)"
```

The token registry contains secret material. Do not commit it.

## Start The HTTP Sidecar

Run the sidecar in one terminal:

```bash
AGENT_MEMORY_BACKEND=postgres \
PGHOST="$PGHOST" \
PGPORT="${PGPORT:-}" \
PGDATABASE="$PGDATABASE" \
PGUSER="$PGUSER" \
PGPASSWORD="$PGPASSWORD" \
AGENT_MEMORY_HTTP_TOKENS_FILE="$PWD/.local/agents-memory/http-tokens.json" \
AGENT_MEMORY_HTTP_HOST=127.0.0.1 \
AGENT_MEMORY_HTTP_PORT=18790 \
npm run http:dev
```

Verify it from another terminal:

```bash
curl -sS http://127.0.0.1:18790/healthz
```

Expected response:

```json
{
  "ok": true,
  "backend": "postgres"
}
```

You can also run:

```bash
node scripts/check-installation.mjs \
  --profile quickstart \
  --check-http \
  --expected-backend postgres \
  --pretty
```

## Write, Search, And Read

Set the HTTP client environment in the second terminal:

```bash
export AGENT_MEMORY_HTTP_BEARER_TOKEN="$(
  node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('.local/agents-memory/http-tokens.json','utf8'));console.log(Object.keys(r)[0])"
)"
export AGENT_MEMORY_BACKEND=http
export AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790
export AGENT_MEMORY_AGENT_ID=local-cli
export AGENT_MEMORY_RUNTIME=local
export AGENT_MEMORY_ROLE=writer
export AGENT_MEMORY_PROJECTS='*'
```

Add a memory and capture its id:

```bash
MEMORY_ID="$(
  node dist/cli.js memory_add '{
    "tenant":"default",
    "project":"demo-app",
    "namespace":"ops",
    "kind":"note",
    "title":"PostgreSQL quickstart memory",
    "body":"Agents Memory Sidecar is using PostgreSQL for durable memory.",
    "source_type":"manual"
  }' | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))"
)"
echo "$MEMORY_ID"
```

Search for it:

```bash
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"durable memory",
  "limit":5
}'
```

Read the full item:

```bash
node dist/cli.js memory_get "{
  \"tenant\":\"default\",
  \"project\":\"demo-app\",
  \"id\":\"$MEMORY_ID\"
}"
```

## Default Production Layout

The bundled Linux operation examples use:

```text
config:  /etc/agents-memory
runtime: /opt/agents-memory-sidecar
backups: /var/backups/agents-memory
```

Review [Operations](operations.md), [Configuration](configuration.md), and
[Security Model](security-model.md) before adapting those paths for a real
machine.
