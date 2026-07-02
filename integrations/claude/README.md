# Claude Code Integration

Create a private env file and launcher from `config/agent-token.env.example` and `config/agents-memory-launcher.sh.example`.

Example:

```bash
claude mcp add agent-memory -s user -- ~/.config/agents-memory/launchers/claude.sh
```

Keep the full bearer token out of Claude config. The config should point to the launcher only.
