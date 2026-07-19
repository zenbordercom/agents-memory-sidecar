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
- HTTP authentication fails closed: the process will not listen without a valid
  token registry, unless explicit loopback-only demo mode is enabled via
  `AGENT_MEMORY_ALLOW_UNAUTHENTICATED_LOCAL=1`.

## Actor Identity

HTTP actor identity is derived from the bearer token registry. The sidecar does not trust model-provided `agent_id`, `runtime`, or `role` fields for authorization.

When a registry is configured, missing or unknown bearer tokens receive HTTP
401. There is no silent fallback to environment actor identity for HTTP
requests.

## Health Checks

`GET /healthz` is intentionally unauthenticated for local liveness checks. It
reports process reachability only and must not be treated as an authorization
boundary. Keep the HTTP listener on loopback so an open health endpoint is not
internet-exposed.

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

Unexpected internal failures return only `{ "error": "internal_error", "request_id": "..." }` to clients. Correlate with server logs using `request_id`.
