#!/usr/bin/env node
import { createHttpApp } from "./http.js";

const host = process.env.AGENT_MEMORY_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.AGENT_MEMORY_HTTP_PORT ?? "18790");

const server = createHttpApp();
server.listen(port, host, () => {
  console.error(`agents-memory HTTP sidecar listening on http://${host}:${port}`);
});
