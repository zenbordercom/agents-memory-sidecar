# Contributing

Agents Memory Sidecar welcomes focused, reviewable contributions. Use Node.js
22 or later. PostgreSQL work additionally requires PostgreSQL 16 with the
`vector` extension; see [Support Matrix](docs/support-matrix.md).

## Before Opening A Pull Request

Keep each change scoped to one behavior, document user-visible configuration
or compatibility changes, and add regression coverage for authorization,
isolation, storage, or release behavior when it changes.

Run the following from a clean checkout:

```bash
npm run typecheck
npm run build
npm test
npm run coverage
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
npm run http:security-smoke
```

`npm run coverage` enforces an initial security-critical coverage floor for
`src/actor.ts`, `src/security.ts`, and `src/http.ts`: 95% lines and 80%
functions. It intentionally does not use repository-wide coverage as a release
gate while the PostgreSQL and CLI suites are still being expanded.

Run `npm run postgres:smoke` when changing migrations, PostgreSQL storage,
search modes, or embedding behavior. It needs a migrated pgvector database.

## Pull Request Expectations

- Explain the problem and the behavioral change.
- Include tests and documentation affected by the change.
- Keep token registries, passwords, and local deployment state out of commits.
- Do not mix formatting-only rewrites with behavioral changes.
- Use the pull request template and report the commands actually run.

Small starter contributions are listed in
[Good First Issues](docs/good-first-issues.md). Security vulnerabilities must
use the private reporting path in [SECURITY.md](SECURITY.md), not public issues.

Do not commit:

- full bearer tokens
- private keys
- database credentials
- backup passphrases
- machine-specific production runbooks
- raw `.env` files
