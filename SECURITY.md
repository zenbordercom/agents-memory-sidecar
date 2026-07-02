# Security Policy

Report security issues privately to the repository maintainer.

Do not include full bearer tokens, private keys, database passwords, backup passphrases, cookies, or raw `.env` files in issues or discussions.

Recommended deployment defaults:

- Bind HTTP to `127.0.0.1`.
- Keep token registries outside Git.
- Use one token per agent.
- Use `writer` for normal agents and reserve `admin` for maintenance.
- Review logs for request metadata only; request bodies and tokens should not be logged.
