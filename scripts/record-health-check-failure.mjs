#!/usr/bin/env node
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

const args = parseArgs(process.argv.slice(2));
const logPath = process.env.AGENT_MEMORY_FAILURE_LOG ?? "/var/log/agents-memory/health-check-failures.jsonl";
const event = {
  timestamp: new Date().toISOString(),
  source: args.source ?? "agents-memory-health-check.service",
  event: "agent_memory_health_check_failed",
  message: "Agent Memory health check failed. Inspect journalctl -u agents-memory-health-check.service for the detailed check output.",
};

mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o640 });
console.log(JSON.stringify(event));

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = "true";
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}
