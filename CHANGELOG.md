# Changelog

## 0.6.0 - 2026-08-22

- **Breaking:** `createHttpApp` no longer accepts a positional `Actor`;
  pass `{ actor, store }` options instead.
- **New:** admin-only soft delete. MCP gains a `memory_delete` tool and HTTP
  gains `DELETE /v1/memory/:id`; both write a `memory.delete` audit event.
  Soft-deleted rows free their content-hash slot, so identical content can be
  re-added.
- Secret scanning now attributes matches by rule name
  (`suspected_secret:<rule>`), adds AWS access key id, JWT, Slack token and
  Telegram bot token patterns, and whitelists benign environment keys for the
  high-false-positive env-assignment rule.
- Hybrid search applies its keyword/embedding match condition inside the CTE,
  preventing scope-wide row materialization before ranking.
- The PostgreSQL pool is explicitly bounded (`AGENT_MEMORY_PG_POOL_MAX`,
  `_CONNECT_TIMEOUT_MS`, `_STATEMENT_TIMEOUT_MS`); response JSON indent is
  configurable via `AGENT_MEMORY_HTTP_JSON_INDENT`.
- ANN indexing for semantic search was evaluated and deliberately deferred;
  see docs/limitations.md for the rationale and revisit criteria.

## 0.5.0 - 2026-08-22

- HTTP request validation now derives from the same shared zod contracts as
  the MCP entry point (`src/schemas.ts`): length caps on memory bodies,
  summaries and observations; confidence restricted to finite [0, 1]; limits
  to integer 1..20; TTL to whole days 1..180; embedding vectors must contain
  finite numbers. Violations return `400 invalid_request` (the historical
  `invalid_search_mode` code is preserved for search modes). Previously some
  malformed optional values were silently dropped.
- Extracted the repeated per-endpoint authorization boilerplate into a single
  `authorize()` helper that writes the denial audit record and throws
  HttpRequestError(403); new endpoints can no longer omit the audit.
- Expanded the real-PostgreSQL regression suite to the read paths: keyword /
  semantic / hybrid search, expiry and soft-delete exclusion, tenant
  isolation, context key filters, and audit records. Coverage gate raised to
  lines >= 92 / functions >= 85 (measured baseline 95.97% / 89.39%).

## 0.4.0 - 2026-08-22

- **Breaking:** token registry files now map SHA-256 hex digests of bearer
  tokens to actor records; plaintext token keys are rejected at startup with an
  actionable error. Convert an existing file with
  `node scripts/migrate-http-tokens.mjs --file <path>` (idempotent; writes a
  timestamped plaintext backup beside the original) or issue fresh tokens via
  `scripts/upsert-http-token.mjs`. Token lookup hashes the presented bearer
  token and compares against stored digests with `crypto.timingSafeEqual` over
  fixed-length buffers.
- `memoryAdd`, `contextSet` and `observationAdd` now run each write and its
  audit insert inside one client-level transaction: audit failures roll the
  write back, data failures leave no audit gap.
- The coverage gate now includes `src/pg-store.ts` and `src/db.ts` (lines >=
  78, functions >= 68) and runs against real PostgreSQL in the CI postgres job
  and the release workflow; a hermetic variant keeps the previous scope for
  jobs without PostgreSQL.
- New real-PostgreSQL regression suite covers concurrent duplicate writes,
  migration rollback atomicity, advisory-lock serialization, grant replay, and
  audit-failure rollback on all three write paths.

## 0.3.3 - 2026-08-22

- Fixed a `memoryAdd` race where concurrent duplicate writes could surface as
  HTTP 500 instead of the documented `duplicate_content` contract; inserts now
  use `ON CONFLICT` against the partial unique index with winner lookup and a
  `memory.duplicate` audit event.
- Made migrations atomic and serialized: every migration now runs in one
  client-level transaction guarded by `pg_advisory_lock`, eliminating the
  pool-based pseudo-transaction that could half-apply a migration.
- Unified database and role naming on `agent_memory` / `agent_memory_app`
  across README, examples, CI, compose bootstrap and docs to match the code
  defaults used by production deployments; existing databases need no rename.
- The MCP server now reports its version from package.json instead of a stale
  hardcoded value.
- Added a real-PostgreSQL regression suite covering concurrent duplicates,
  migration rollback atomicity, advisory-lock serialization, and grant replay;
  it runs in the CI postgres job against a disposable database.

## 0.3.2 - 2026-08-04

- Updated the MCP SDK and vulnerable transitive dependencies so production and
  development dependency audits report zero known vulnerabilities.
- Added production and full dependency audit gates to CI and tagged releases.
- Reconciled the v0.3 construction status and documented the verified v0.3.1
  Trusted Publishing, provenance, integrity, and release recovery evidence.

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
