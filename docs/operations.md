# Operations

This project includes operational scripts for local Linux deployments. Review and adapt them before using in production.

## Build

```bash
npm run typecheck
npm run build
```

## Health Check

```bash
node scripts/health-check.mjs --pretty
```

Common production usage:

```bash
AGENT_MEMORY_CONFIG_FILE=/etc/agents-memory/sidecar.env \
AGENT_MEMORY_HTTP_TOKENS_FILE=/etc/agents-memory/http-tokens.json \
node scripts/health-check.mjs --pretty
```

## Installation Check

```bash
node scripts/check-installation.mjs \
  --source-dir "$PWD" \
  --runtime-dir /opt/agents-memory-sidecar \
  --env-file /etc/agents-memory/sidecar.env \
  --token-file /etc/agents-memory/http-tokens.json \
  --backup-dir /var/backups/agents-memory \
  --pretty
```

## Systemd

The `systemd/` directory contains example units. Adjust paths, users, groups, hardening options, and database configuration before installing.

## Token Maintenance

```bash
node scripts/upsert-http-token.mjs --list --file /etc/agents-memory/http-tokens.json
```

Generate or replace a writer token:

```bash
node scripts/upsert-http-token.mjs \
  --file /etc/agents-memory/http-tokens.json \
  --agent-id codex-cli \
  --runtime codex \
  --role writer \
  --projects '*'
```

The script prints token fingerprints and actor metadata. Do not commit the token registry.
