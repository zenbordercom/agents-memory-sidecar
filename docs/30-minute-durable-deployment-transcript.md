# 30-Minute Durable Deployment Transcript

This transcript walks through a local PostgreSQL deployment with durable memory,
HTTP bearer-token authentication, and CLI validation.

Use it after the 5-minute demo path is working.

## Build The Project

```bash
npm install
npm run build
```

## Create A Local PostgreSQL Database

This example uses a system PostgreSQL installation. Choose your own password.

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_memory_app') THEN
    CREATE ROLE agent_memory_app LOGIN PASSWORD 'change-me';
  END IF;
END
$$;
SELECT 'CREATE DATABASE agent_memory OWNER agent_memory_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agent_memory')\gexec
\c agent_memory
CREATE EXTENSION IF NOT EXISTS vector;
SQL
```

Set the connection environment:

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=agent_memory
export PGUSER=agent_memory_app
export PGPASSWORD=change-me
export AGENT_MEMORY_BACKEND=postgres
```

This password-based transcript uses TCP localhost to avoid Unix-socket peer auth
surprises on common Debian/Ubuntu PostgreSQL defaults.

## Run Migrations And PostgreSQL Smoke

```bash
AGENT_MEMORY_BACKEND=postgres npm run db:migrate
npm run postgres:smoke
```

Expected result:

```text
applied 001_initial.sql
applied 002_observation_prune_grant.sql
postgres smoke ok
```

## Create A Local Token Registry

```bash
mkdir -p .local/agents-memory
node scripts/upsert-http-token.mjs \
  --file .local/agents-memory/http-tokens.json \
  --agent-id local-cli \
  --runtime local \
  --role writer \
  --projects '*'
```

Expected result:

```json
{
  "fingerprint": "000000000000",
  "actor": {
    "tenant": "default",
    "agentId": "local-cli",
    "runtime": "local",
    "role": "writer",
    "projects": ["*"]
  }
}
```

Load the generated token into the current shell:

```bash
export AGENT_MEMORY_HTTP_BEARER_TOKEN="$(
  node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('.local/agents-memory/http-tokens.json','utf8'));const e=Object.entries(r).find(([,a])=>a.agentId==='local-cli'&&a.runtime==='local');if(!e) throw new Error('local-cli/local token not found');console.log(e[0])"
)"
```

## Start The HTTP Sidecar

In terminal 1:

```bash
AGENT_MEMORY_BACKEND=postgres \
PGHOST="$PGHOST" \
PGDATABASE="$PGDATABASE" \
PGUSER="$PGUSER" \
PGPASSWORD="$PGPASSWORD" \
AGENT_MEMORY_HTTP_TOKENS_FILE="$PWD/.local/agents-memory/http-tokens.json" \
AGENT_MEMORY_HTTP_HOST=127.0.0.1 \
AGENT_MEMORY_HTTP_PORT=18790 \
npm run http:dev
```

Expected result:

```text
agents-memory HTTP sidecar listening on http://127.0.0.1:18790
```

## Check The HTTP Sidecar

In terminal 2:

```bash
curl -sS http://127.0.0.1:18790/healthz
```

Expected result:

```json
{
  "ok": true,
  "backend": "postgres"
}
```

Run the quickstart diagnostic against the running sidecar:

```bash
node scripts/check-installation.mjs \
  --profile quickstart \
  --check-http \
  --expected-backend postgres \
  --pretty
```

Expected result:

```json
{
  "status": "ok",
  "profile": "quickstart",
  "checks": [
    { "name": "http:healthz", "status": "ok", "backend": "postgres" }
  ]
}
```

## Write, Search, And Read Through HTTP

Set the CLI HTTP backend:

```bash
export AGENT_MEMORY_BACKEND=http
export AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790
export AGENT_MEMORY_AGENT_ID=local-cli
export AGENT_MEMORY_RUNTIME=local
export AGENT_MEMORY_ROLE=writer
export AGENT_MEMORY_PROJECTS='*'
```

Add a memory:

```bash
MEMORY_ID="$(
  node dist/cli.js memory_add '{
    "tenant":"default",
    "project":"demo-app",
    "namespace":"ops",
    "kind":"note",
    "title":"Durable deployment memory",
    "body":"Agents Memory Sidecar is writing durable memory through the local HTTP sidecar.",
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
  "query":"durable memory HTTP sidecar",
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

Expected result:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "project": "demo-app",
  "namespace": "ops",
  "kind": "note",
  "title": "Durable deployment memory",
  "source_type": "manual"
}
```

## Optional Semantic Search Check

After pulling an Ollama embedding model and backfilling vectors, switch to
hybrid search:

```bash
export AGENT_MEMORY_SEARCH_MODE=hybrid
export AGENT_MEMORY_EMBEDDING_MODEL=nomic-embed-text
export AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

See [Semantic And Hybrid Search](semantic-search.md) for the full backfill
workflow.

## Done

At this point the local deployment has durable PostgreSQL storage, a bearer-token
HTTP boundary, and a validated CLI path for write/search/read.
