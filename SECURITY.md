# Security Policy

## Reporting A Vulnerability

Report vulnerabilities privately through GitHub's repository security advisory
form:

<https://github.com/zenbordercom/agents-memory-sidecar/security/advisories/new>

If the form is unavailable, open a minimal public issue that contains no
technical details and requests a private contact channel. Maintainers must
enable GitHub private vulnerability reporting before the v0.3.0 release.

Do not include full bearer tokens, private keys, database passwords, backup
passphrases, cookies, raw `.env` files, memory bodies, or reproduction data
containing secrets in any report.

## Supported Versions

Security fixes target the latest published stable release. See the
[Support Matrix](docs/support-matrix.md) for runtime support.

## Recommended Deployment Defaults

- Bind HTTP to `127.0.0.1`.
- Keep token registries outside Git.
- Use one token per agent.
- Use `writer` for normal agents and reserve `admin` for maintenance.
- Review logs for request metadata only; request bodies and tokens should not be logged.
