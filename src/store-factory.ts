import { createPgPool } from "./db.js";
import { HttpStore } from "./http-store.js";
import { PgStore } from "./pg-store.js";
import { FakeStore, type MemoryStore } from "./store.js";

export function createStoreFromEnv(): MemoryStore {
  if (process.env.AGENT_MEMORY_BACKEND === "http") {
    return new HttpStore();
  }

  if (process.env.AGENT_MEMORY_BACKEND === "postgres") {
    return new PgStore(createPgPool());
  }

  return FakeStore.fromEnv();
}
