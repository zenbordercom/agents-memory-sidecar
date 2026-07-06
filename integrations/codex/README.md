# Codex Integration

This guide connects Codex CLI to Agents Memory Sidecar through the stdio MCP
wrapper.

The recommended shape is:

```text
Codex -> launcher script -> agents-memory-mcp -> localhost HTTP sidecar
```

Keep the full bearer token in a private env file. Do not put it directly in the
Codex MCP config.

## Prerequisites

- Agents Memory Sidecar is built or installed.
- The HTTP sidecar is running on `127.0.0.1`.
- A bearer token exists in the HTTP token registry for a Codex actor.
- `codex mcp add --help` shows support for stdio MCP servers.

For local setup, first follow the repository README or
`docs/postgres-quickstart.md`.

## Create A Codex Token

For a local development checkout, create a private token registry:

```bash
mkdir -p "$HOME/.config/agents-memory/tokens"
mkdir -p "$HOME/.config/agents-memory/launchers"

node scripts/upsert-http-token.mjs \
  --file "$HOME/.config/agents-memory/http-tokens.json" \
  --agent-id codex-cli \
  --runtime codex \
  --role writer \
  --projects '*'
```

The script prints a token fingerprint only. Load the full token from the private
registry when creating the env file:

```bash
TOKEN="$(
  node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(Object.keys(r)[0])" \
    "$HOME/.config/agents-memory/http-tokens.json"
)"
```

## Create The Env File

```bash
cat > "$HOME/.config/agents-memory/tokens/codex.env" <<EOF
AGENT_MEMORY_BACKEND=http
AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790
AGENT_MEMORY_HTTP_BEARER_TOKEN=$TOKEN
AGENT_MEMORY_AGENT_ID=codex-cli
AGENT_MEMORY_RUNTIME=codex
AGENT_MEMORY_ROLE=writer
AGENT_MEMORY_TENANT=default
AGENT_MEMORY_PROJECTS=*
EOF

chmod 600 "$HOME/.config/agents-memory/tokens/codex.env"
```

Normal Codex usage should use a `writer` token. Use `admin` only for controlled
maintenance because `project_context_set` is admin-only.

## Create The Launcher

If `agents-memory-mcp` is installed globally, use it directly:

```bash
cat > "$HOME/.config/agents-memory/launchers/codex.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${AGENT_MEMORY_TOKEN_ENV:-$HOME/.config/agents-memory/tokens/codex.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "agents-memory launcher: missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

exec agents-memory-mcp
EOF

chmod 700 "$HOME/.config/agents-memory/launchers/codex.sh"
```

If you deploy the repository to `/opt/agents-memory-sidecar`, replace the final
line with:

```bash
exec node /opt/agents-memory-sidecar/dist/server.js
```

## Register With Codex

```bash
codex mcp add agent-memory -- "$HOME/.config/agents-memory/launchers/codex.sh"
```

Inspect the registered server:

```bash
codex mcp list
codex mcp get agent-memory
```

## Validate The Sidecar Before Using Codex

Source the same env file and call the HTTP sidecar through the CLI backend:

```bash
set -a
source "$HOME/.config/agents-memory/tokens/codex.env"
set +a

agents-memory memory_search '{
  "tenant":"default",
  "project":"demo-app",
  "query":"deployment",
  "limit":5
}'
```

If that command fails, fix the sidecar, token, or network configuration before
debugging Codex.

## Validate Through Codex

Start Codex in a project directory and ask it to use the `agent-memory` MCP
server.

Recommended validation prompts:

```text
Use the agent-memory MCP server. Call project_context_get for tenant default and project demo-app.
```

```text
Use the agent-memory MCP server. Call memory_search for tenant default, project demo-app, query "deployment", limit 5.
```

```text
Use the agent-memory MCP server. Add a memory for tenant default, project demo-app, namespace ops, kind note, title "Codex integration check", body "Codex can write to Agents Memory Sidecar through MCP.", source_type manual.
```

Expected tools:

- `project_context_get`
- `memory_search`
- `memory_get`
- `memory_add`
- `agent_observation_add`
- `project_context_set` only works with an admin token

## Recommended Codex Workflow

- At the start of project work, call `project_context_get`.
- Before changing a project, call `memory_search` with a short targeted query.
- Use `memory_get` when a search result needs full context.
- After an important fact is verified, call `memory_add`.
- Use `agent_observation_add` for temporary process notes.
- Do not store secrets, raw `.env` files, cookies, private keys, or full bearer
  tokens.

## Common Failures

- `agents-memory launcher: missing env file`: create
  `$HOME/.config/agents-memory/tokens/codex.env` or set
  `AGENT_MEMORY_TOKEN_ENV`.
- `command not found: agents-memory-mcp`: install the package globally or point
  the launcher at `/opt/agents-memory-sidecar/dist/server.js`.
- `ECONNREFUSED` or HTTP connection errors: start `agents-memory-http` or the
  systemd sidecar, then check `http://127.0.0.1:18790/healthz`.
- `unauthorized`: the sidecar token registry does not contain the bearer token
  from `codex.env`.
- `permission_denied`: the token actor role or `projects` list does not allow
  the requested operation.
- Empty search results: confirm the project name is consistent and try a
  shorter query.
- `project_context_set` fails: use an admin token only for setup or maintenance.
