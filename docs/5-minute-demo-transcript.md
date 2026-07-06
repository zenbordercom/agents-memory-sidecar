# 5-Minute Demo Transcript

This transcript verifies the local demo path without PostgreSQL, systemd, or
production config files. It uses the fake JSON store.

## Start From A Checkout

```bash
git clone https://github.com/zenbordercom/agents-memory-sidecar.git
cd agents-memory-sidecar
npm install
npm run build
```

Expected result:

```text
> agents-memory-sidecar@... build
> tsc -p tsconfig.json
```

## Check The Build

```bash
node scripts/check-installation.mjs --profile quickstart --pretty
```

Expected result:

```json
{
  "status": "ok",
  "profile": "quickstart",
  "checks": [
    { "name": "build:cli", "status": "ok" },
    { "name": "build:mcp_wrapper", "status": "ok" },
    { "name": "build:http_server", "status": "ok" },
    { "name": "package:metadata", "status": "ok" }
  ]
}
```

## Run Demo Smoke Tests

```bash
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
```

Expected result:

```text
smoke ok
http smoke ok
http bridge smoke ok
```

## Use The CLI With A Temporary Fake Store

Use a temporary store so the demo does not modify repository state:

```bash
DEMO_DIR="$(mktemp -d)"
export AGENT_MEMORY_STORE_PATH="$DEMO_DIR/fake-store.json"
export AGENT_MEMORY_AGENT_ID=local-cli
export AGENT_MEMORY_RUNTIME=local
export AGENT_MEMORY_ROLE=writer
export AGENT_MEMORY_PROJECTS='*'
```

Add a durable memory item:

```bash
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

Expected result:

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "accepted": true,
  "warnings": []
}
```

Search for it:

```bash
node dist/cli.js memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"demo mode",
  "limit":5
}'
```

Expected result:

```json
{
  "items": [
    {
      "title": "Demo memory",
      "project": "demo-app",
      "namespace": "ops",
      "source_type": "manual"
    }
  ]
}
```

Clean up:

```bash
rm -rf "$DEMO_DIR"
```

## Done

At this point the checkout, build output, fake store, HTTP smoke path, and MCP
bridge smoke path are working.
