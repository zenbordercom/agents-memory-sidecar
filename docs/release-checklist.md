# Release Checklist

Use this checklist for tagged releases such as `v0.2.0`.

## Related Docs

- [5-Minute Demo Transcript](5-minute-demo-transcript.md)
- [30-Minute Durable Deployment Transcript](30-minute-durable-deployment-transcript.md)
- [Operations](operations.md)
- [Security Model](security-model.md)

## Preflight

- Confirm the working tree contains only intended changes.
- Review public docs for secrets, private paths, local-only tokens, passwords,
  and project-specific assumptions.
- Confirm `CHANGELOG.md` has an entry for the target version.
- Confirm `package.json` has the target version.

## Local Validation

Run the local checks:

```bash
npm ci
npm run typecheck
npm run build
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
node scripts/check-installation.mjs --profile quickstart --pretty
```

Run PostgreSQL validation against a database with pgvector:

```bash
AGENT_MEMORY_BACKEND=postgres npm run db:migrate
npm run postgres:smoke
```

For semantic search changes, also run:

```bash
node scripts/embedding-readiness-report.mjs --model nomic-embed-text --pretty
node scripts/embedding-backfill-ollama.mjs --model nomic-embed-text --limit 10 --pretty
```

## Package Validation

Check the package contents without publishing:

```bash
npm pack --dry-run
```

The package should include:

- `dist/`
- `migrations/`
- `docs/`
- `config/*.example*`
- `integrations/`
- `scripts/`
- `systemd/`
- `README.md`
- `LICENSE`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`

The package must not include:

- `.env`
- `.local/`
- `data/*.json`
- real token registries
- database passwords
- backup passphrases
- generated local backups

Create the tarball:

```bash
npm pack
```

## Version And Tag

If the version still needs to be updated:

```bash
npm version 0.2.0 --no-git-tag-version
```

After final validation:

```bash
git status --short
git add package.json package-lock.json CHANGELOG.md README.md docs integrations scripts systemd config migrations src
git commit -m "Prepare v0.2.0 release"
git tag v0.2.0
```

## GitHub Release

- Push the branch and tag.
- Confirm CI passes on the tag.
- Create a GitHub release for the tag.
- Attach the `agents-memory-sidecar-0.2.0.tgz` artifact if publishing release
  tarballs through GitHub.
- Confirm the README install commands reference the released version.

## Post-Release Smoke

Install from the release artifact or registry and run:

```bash
agents-memory --help
command -v agents-memory-mcp
command -v agents-memory-http
```

Then run the README demo path from a fresh directory.
