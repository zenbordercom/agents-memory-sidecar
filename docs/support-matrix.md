# Support Matrix

This matrix defines the environments exercised by CI or release validation.
Other environments may work but are not release-blocking until added here.

| Component       | Supported / tested baseline         | Notes                                                                      |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Node.js         | 22.x, 24.x                          | `package.json` requires Node.js 22 or later.                               |
| Linux           | Ubuntu latest GitHub Actions runner | Native systemd examples target Linux.                                      |
| macOS / Windows | Source and CLI use, best effort     | Docker Compose is the recommended durable local path.                      |
| PostgreSQL      | 16                                  | CI uses PostgreSQL 16 via `pgvector/pgvector:pg16`.                        |
| pgvector        | Image-provided version              | `CREATE EXTENSION vector` is required for migrations.                      |
| Docker Compose  | Current Docker Compose plugin       | Used by the durable local deployment example.                              |
| MCP clients     | Codex, Claude Code, Grok, agy, Pi   | Integration examples are included; clients remain independently versioned. |

Run `npm test` and `npm run coverage` on every supported Node release. Run
`npm run postgres:smoke` on the PostgreSQL 16 + pgvector baseline when changing
durable storage or search behavior.
