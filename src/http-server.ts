#!/usr/bin/env node
import { attachGracefulShutdown, createHttpApp, resolveHttpAuthFromEnv } from "./http.js";
import { createStoreFromEnv } from "./store-factory.js";

const host = process.env.AGENT_MEMORY_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.AGENT_MEMORY_HTTP_PORT ?? "18790");

try {
  const auth = resolveHttpAuthFromEnv(process.env, host);
  const store = createStoreFromEnv();
  const server = createHttpApp({
    auth,
    store,
    actor: auth.fallback,
    host,
  });

  attachGracefulShutdown(server);

  server.listen(port, host, () => {
    const mode =
      auth.mode === "token_registry" ? "token_registry" : "unauthenticated_local";
    console.error(
      `agents-memory HTTP sidecar listening on http://${host}:${port} (auth=${mode})`,
    );
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agents-memory-http failed to start: ${message}`);
  process.exit(1);
}
