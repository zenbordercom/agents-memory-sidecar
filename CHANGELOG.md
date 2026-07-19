# Changelog

## 0.3.1 - 2026-07-19

- Fixed release validation so the Compose persistence smoke uses an isolated
  PostgreSQL host port when the Release job's pgvector service occupies 5432.

## 0.3.0 - 2026-07-19

- Made the HTTP sidecar fail closed unless a valid token registry is configured;
  loopback-only unauthenticated demo mode now requires explicit opt-in.
- Added HTTP authorization, isolation, input-validation, secret-scanning, and
  graceful-shutdown regression coverage with Node.js 22 and 24 CI validation.
- Added PostgreSQL lifecycle and semantic/hybrid benchmark validation using
  pgvector in CI, including explicit keyword fallback evidence.
- Added production Docker Compose deployment, token bootstrap, and a CI
  persistence smoke that exercises the CLI HTTP write/search/read path.
- Added release package verification, tag/package/changelog checks, provenance
  publication workflow, release environment guard, and npm integrity metadata.
- Completed Apache License 2.0 text, public security-reporting guidance,
  contribution templates, support matrix, governance documentation, and
  clean-room demo evidence.

## 0.2.1 - 2026-07-06

- Clarified that GitHub release installs are the authoritative current release path unless the npm registry has been updated.
- Fixed token-loading snippets so they select the intended actor token instead of the first registry entry.
- Clarified PostgreSQL localhost TCP usage for password-based quickstarts on peer-auth systems.
- Tightened Codex integration instructions for source-checkout versus global-install layouts.
- Updated release checklist staging and optional npm publish verification guidance.

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
