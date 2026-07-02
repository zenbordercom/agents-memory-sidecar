# agy Integration

Use the plugin under `integrations/agy/agent-memory`.

The plugin MCP config should point to a launcher script:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "~/.config/agents-memory/launchers/agy.sh"
    }
  }
}
```

Keep the bearer token in a private env file sourced by the launcher.
