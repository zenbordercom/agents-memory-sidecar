#!/usr/bin/env node
import { actorFromEnv, canAdmin, canRead, canWrite } from "./actor.js";
import { scanForSecrets } from "./security.js";
import { createStoreFromEnv } from "./store-factory.js";

type CommandInput = Record<string, unknown>;

async function main() {
  const [command, rawInput] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const input = await parseInput(rawInput);
  const actor = actorFromEnv();
  const store = createStoreFromEnv();

  try {
    switch (command) {
      case "memory_search": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canRead(actor, tenant, project)) return print({ error: "permission_denied" });
        return print({
        items: await store.memorySearch({
          tenant,
          project,
          query: requiredString(input.query, "query"),
          namespace: optionalString(input.namespace),
          kind: optionalString(input.kind),
          limit: numberOrDefault(input.limit, 5, 1, 20),
        }),
      });
      }

      case "memory_get": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canRead(actor, tenant, project)) return print({ error: "permission_denied" });
      const item = await store.memoryGet({
        tenant,
        project,
        id: requiredString(input.id, "id"),
      });
        return print(item ?? { error: "not_found" });
      }

      case "project_context_get": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canRead(actor, tenant, project)) return print({ error: "permission_denied" });
        return print({
        project,
        contexts: await store.contextGet({
          tenant,
          project,
          keys: arrayOfStrings(input.keys),
        }),
      });
      }

      case "memory_add": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canWrite(actor, tenant, project)) return print({ error: "permission_denied" });
      const warnings = scanForSecrets(input);
      if (warnings.length) return print({ accepted: false, warnings });
        return print(
        await store.memoryAdd(actor, {
          tenant,
          project,
          namespace: stringOrDefault(input.namespace, "ops"),
          kind: requiredString(input.kind, "kind"),
          title: optionalString(input.title),
          body: requiredString(input.body, "body"),
          summary: optionalString(input.summary),
          metadata: objectOrDefault(input.metadata),
          source_type: sourceType(input.source_type),
          source_ref: optionalString(input.source_ref),
          confidence: optionalNumber(input.confidence),
        }),
      );
      }

      case "agent_observation_add": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canWrite(actor, tenant, project)) return print({ error: "permission_denied" });
      const warnings = scanForSecrets(input);
      if (warnings.length) return print({ accepted: false, warnings });
        return print(
        await store.observationAdd(actor, {
          tenant,
          project,
          session_id: optionalString(input.session_id),
          observation: requiredString(input.observation, "observation"),
          metadata: objectOrDefault(input.metadata),
          ttl_days: numberOrDefault(input.ttl_days, 30, 1, 180),
        }),
      );
      }

      case "project_context_set": {
      const tenant = stringOrDefault(input.tenant, actor.tenant);
      const project = requiredString(input.project, "project");
      if (!canAdmin(actor, tenant, project)) return print({ error: "permission_denied" });
      const warnings = scanForSecrets(input);
      if (warnings.length) return print({ accepted: false, warnings });
        return print(
        await store.contextSet(actor, {
          tenant,
          project,
          key: requiredString(input.key, "key"),
          value: input.value,
          source_ref: optionalString(input.source_ref),
          note: optionalString(input.note),
        }),
      );
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    await store.close?.();
  }
}

async function parseInput(rawInput?: string): Promise<CommandInput> {
  if (rawInput) {
    return JSON.parse(rawInput) as CommandInput;
  }

  const stdin = await readStdin();
  return stdin.trim() ? (JSON.parse(stdin) as CommandInput) : {};
}

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  print({
    usage: "agents-memory <command> '<json-args>'",
    commands: [
      "memory_search",
      "memory_get",
      "project_context_get",
      "memory_add",
      "agent_observation_add",
      "project_context_set",
    ],
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string: ${name}`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function numberOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected integer between ${min} and ${max}`);
  }
  return number;
}

function arrayOfStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function objectOrDefault(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceType(value: unknown) {
  const allowed = new Set(["user", "agent", "file", "command", "url", "system", "manual", "import"]);
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error("Invalid source_type");
  }
  return value as any;
}

main().catch((error) => {
  print({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
