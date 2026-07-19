# Release Checklist

Use this checklist for tagged releases. Replace `0.3.0` with the target version.

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
npm run docs:check
npm test
npm run coverage
npm run smoke
npm run http:smoke
npm run http:bridge-smoke
npm run http:security-smoke
node scripts/verify-release.mjs --version 0.3.0 --tag v0.3.0
node scripts/verify-package.mjs
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
- `fixtures/`
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

## Release Paths

- Stable: use a final semver version such as `0.3.0`, add a matching dated
  changelog heading, and push `v0.3.0`. The workflow publishes npm `latest`.
- Prerelease: use a prerelease semver version such as `0.3.0-rc.1`, add a
  matching changelog heading, and push `v0.3.0-rc.1`. The workflow publishes
  npm `next` and never moves `latest`.
- Hotfix: use a final patch version such as `0.3.1`, document the focused fix,
  and push `v0.3.1`. It follows the stable path and publishes `latest`.

The release workflow rejects a tag/package/changelog mismatch and refuses to
republish an existing npm version.

## Version And Tag

If the version still needs to be updated:

```bash
npm version 0.3.0 --no-git-tag-version
```

After final validation:

```bash
git status --short
git add -A
git commit -m "Prepare v0.3.0 release"
git tag -a v0.3.0 -m "v0.3.0"
```

## GitHub Release

- Push the branch and tag. The protected GitHub Actions `Release` workflow is
  the only stable publication path.
- Configure npm Trusted Publishing for `zenbordercom/agents-memory-sidecar`
  and the repository's `Release` workflow before the first automated release.
  It uses GitHub OIDC, npm provenance, and the protected `npm` environment.
- The workflow publishes the package, verifies the intended dist-tag, and
  creates the GitHub Release with npm integrity metadata.
- If Trusted Publishing is unavailable, maintainers may temporarily change the
  publish step to use an automation token with only package publish scope,
  stored as the protected `NPM_TOKEN` environment secret. Do not use a personal
  broad-scope token or publish from a workstation; restore the tokenless OIDC
  publish step after Trusted Publishing is configured.

## Post-Release Smoke

Install from the release artifact or registry and run:

```bash
agents-memory --help
command -v agents-memory-mcp
command -v agents-memory-http
```

Then run the README demo path from a fresh directory.
