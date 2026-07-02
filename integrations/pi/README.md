# Pi Integration

`agent-memory.ts` is a sample Pi extension that registers:

- `agent_memory_search`
- `agent_memory_get`
- `agent_memory_context_get`
- `agent_memory_observation_add`

The extension reads `~/.config/agents-memory/tokens/pi.env` by default. Adapt the path for your environment or set `AGENT_MEMORY_PI_ENV_FILE`.
