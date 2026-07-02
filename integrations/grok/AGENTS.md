# Shared Memory (Agents Memory Sidecar)

Use the `agent-memory` MCP server when prior operational context may affect a task.

## Rules

- **Search before changing**: Use `agent-memory__memory_search` before modifying known services or deployment settings.
- **Read project context**: Use `agent-memory__project_context_get` before acting on known projects such as `server-ops`, `demo-app`, or your own project names.
- **Write after validating**: Use `agent-memory__agent_observation_add` after confirming an operational fact that may help a future session.
- **No secrets**: Never store secrets, complete tokens, private keys, cookies, or full `.env` content in shared memory.
- **Project scope**: Always specify the correct `project` parameter when calling memory tools.

## Workflow

1. **Start of task**: Search memory for relevant context, then read project context if applicable.
2. **During task**: If you discover or validate an important operational fact, add an observation.
3. **End of task**: Use `agent-memory__memory_add` for stable facts that should persist across sessions.
