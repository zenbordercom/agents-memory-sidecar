# Codex Integration

Create a private env file and launcher from `config/agent-token.env.example` and `config/agents-memory-launcher.sh.example`.

Example:

```bash
codex mcp add agent-memory -- ~/.config/agents-memory/launchers/codex.sh
```

Keep the full bearer token out of Codex config. The config should point to the launcher only.
