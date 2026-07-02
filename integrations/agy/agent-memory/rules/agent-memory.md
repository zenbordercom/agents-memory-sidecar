# Shared Memory

Use the `agent-memory` MCP server when prior operational context may affect a task.

- Search memory before changing known services or deployment settings.
- Read project context before acting on known projects such as `server-ops`, `demo-app`, or your own project names.
- Add a short observation after validating an operational fact that may help a future session.
- Do not store secrets, complete tokens, private keys, cookies, or full `.env` content.
