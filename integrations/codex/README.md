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

- Agents Memory Sidecar is built from a source checkout or installed globally.
- The HTTP sidecar is running on `127.0.0.1`.
- A bearer token exists in the HTTP token registry for a Codex actor.
- `codex mcp add --help` shows support for stdio MCP servers.

For local setup, first follow the repository README or
`docs/postgres-quickstart.md`.

When using a source checkout, run the commands below from that checkout. When
using a global install, run the token helper through `npm explore -g` as shown
below.

## Create A Codex Token

For a source checkout, create a private token registry:

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

For a global install, use the installed package copy of the helper:

```bash
mkdir -p "$HOME/.config/agents-memory/tokens"
mkdir -p "$HOME/.config/agents-memory/launchers"

npm explore -g agents-memory-sidecar -- node scripts/upsert-http-token.mjs \
  --file "$HOME/.config/agents-memory/http-tokens.json" \
  --agent-id codex-cli \
  --runtime codex \
  --role writer \
  --projects '*'
```

The script prints a token fingerprint only. Generate your own bearer token and
register it (the file stores only the SHA-256 digest, so keep the plaintext
token in your shell/env file):

```bash
TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
node scripts/upsert-http-token.mjs \
  --file "$HOME/.config/agents-memory/http-tokens.json" \
  --token "$TOKEN" \
  --agent-id codex-cli \
  --runtime codex \
  --role writer \
  --projects '*'
```
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

Create a launcher. If you use a source checkout, set
`AGENTS_MEMORY_SIDECAR_DIR` to that checkout path. If the variable is not set,
the launcher uses the global `agents-memory-mcp` binary.

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

if [[ -n "${AGENTS_MEMORY_SIDECAR_DIR:-}" ]]; then
  exec node "$AGENTS_MEMORY_SIDECAR_DIR/dist/server.js"
fi

exec agents-memory-mcp
EOF

chmod 700 "$HOME/.config/agents-memory/launchers/codex.sh"
```

For a source checkout, add the checkout path to `codex.env`:

```bash
echo "AGENTS_MEMORY_SIDECAR_DIR=/absolute/path/to/agents-memory-sidecar" >> "$HOME/.config/agents-memory/tokens/codex.env"
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

Source the same env file and call the HTTP sidecar through the CLI backend.
Use `agents-memory` if the package is installed globally, or `node dist/cli.js`
from a source checkout:

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

Source checkout equivalent:

```bash
node dist/cli.js memory_search '{
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
