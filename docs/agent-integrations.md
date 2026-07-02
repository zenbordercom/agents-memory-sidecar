# Agent Integrations

Use a private env file and launcher script for each agent.

## Launcher Pattern

```bash
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${AGENT_MEMORY_TOKEN_ENV:-$HOME/.config/agents-memory/tokens/codex.env}"
if [[ ! -r "$ENV_FILE" ]]; then
  echo "agents-memory launcher: missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

exec node /opt/agents-memory-sidecar/dist/server.js
```

Token env files should be mode `0600`. Launcher scripts should be mode `0700`.

## Env File

```bash
AGENT_MEMORY_BACKEND=http
AGENT_MEMORY_HTTP_BASE_URL=http://127.0.0.1:18790
AGENT_MEMORY_HTTP_BEARER_TOKEN=replace-with-real-token
AGENT_MEMORY_AGENT_ID=codex-cli
AGENT_MEMORY_RUNTIME=codex
AGENT_MEMORY_ROLE=writer
AGENT_MEMORY_TENANT=default
AGENT_MEMORY_PROJECTS=*
```

## Agent-Specific Notes

- Codex: configure an MCP server command pointing at the launcher.
- Claude Code: register the launcher with `claude mcp add`.
- Grok: configure `mcp_servers.agent-memory.command`.
- agy: use a plugin `mcp_config.json` that points at the launcher.
- Pi: use the extension in `integrations/pi` or adapt it for your Pi version.

See the `integrations/` directory for examples.
