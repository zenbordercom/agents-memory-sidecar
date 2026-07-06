# Changelog

## 0.2.0 - 2026-07-06

- Restructured the README quick start into demo, local HTTP sidecar, and durable PostgreSQL paths.
- Added quickstart diagnostics to `scripts/check-installation.mjs`.
- Added PostgreSQL quickstart, semantic/hybrid search, and release checklist documentation.
- Expanded the Codex integration guide with token env, launcher, MCP registration, validation flows, and troubleshooting.
- Documented local development token handling and ignored `.local/` development state.

## 0.1.1 - 2026-07-02

- Added PostgreSQL + pgvector CI coverage.
- Added `postgres:smoke` validation for migrations, keyword search, semantic search, and hybrid search.
- Added pgvector-backed semantic and hybrid search modes for PostgreSQL.
- Documented npm registry installation in the published README.

## 0.1.0 - 2026-07-02

Initial public release.

- Local-first MCP shared memory sidecar for multiple AI agents.
- HTTP sidecar with bearer-token actor registry.
- PostgreSQL backend with migrations and fake JSON backend for local testing.
- MCP tools for memory search/get/add, project context get/set, and agent observations.
- Generic integration examples for Codex, Claude Code, Grok, agy, and Pi.
- Linux systemd templates, backup scripts, health checks, and local installation helper.
- Public documentation for configuration, operations, security, backups, and limitations.
