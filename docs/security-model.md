# Security Model

Agents Memory Sidecar assumes a local-first deployment.

## Related Docs

- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [Agent Integrations](agent-integrations.md)
- [Operations](operations.md)
- [Backup And Restore](backup-restore.md)

## Boundaries

- Bind the HTTP sidecar to `127.0.0.1`.
- Do not expose the HTTP API directly to the public internet.
- Treat the token registry as secret material.
- Use a separate bearer token for each agent runtime.

## Actor Identity

HTTP actor identity is derived from the bearer token registry. The sidecar does not trust model-provided `agent_id`, `runtime`, or `role` fields for authorization.

## Authorization

- Readers can search and read.
- Writers can add durable memories and observations.
- Admins can update project context.

Project access can be restricted by the token actor's `projects` list.

## Secret Handling

The sidecar rejects common secret-like payloads before writing memory or observations. This is a guardrail, not a complete data-loss prevention system.

Do not store:

- full bearer tokens
- private keys
- database passwords
- backup passphrases
- raw `.env` files
- cookies or session material

## Logging

Request logs include route, status, duration, actor, tenant, project, and error. They do not log request bodies or bearer tokens.
