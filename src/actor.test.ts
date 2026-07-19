import { strict as assert } from "node:assert";
import test from "node:test";
import { actorFromEnv, canAdmin, canRead, canWrite } from "./actor.js";
import type { Actor } from "./types.js";

const writer: Actor = {
  tenant: "default",
  agentId: "writer",
  runtime: "test",
  workspace: "/tmp",
  role: "writer",
  projects: ["allowed"],
};

test("actorFromEnv applies safe local defaults and trims project lists", () => {
  const actor = actorFromEnv({ AGENT_MEMORY_PROJECTS: " one, ,two " });
  assert.equal(actor.tenant, "default");
  assert.equal(actor.role, "writer");
  assert.deepEqual(actor.projects, ["one", "two"]);
});

test("actorFromEnv rejects unknown roles", () => {
  assert.throws(
    () => actorFromEnv({ AGENT_MEMORY_ROLE: "owner" }),
    /Invalid AGENT_MEMORY_ROLE: owner/,
  );
});

test("role and project authorization enforce tenant isolation", () => {
  assert.equal(canRead(writer, "default", "allowed"), true);
  assert.equal(canRead(writer, "other-tenant", "allowed"), false);
  assert.equal(canRead(writer, "default", "other-project"), false);
  assert.equal(canWrite(writer, "default", "allowed"), true);
  assert.equal(canAdmin(writer, "default", "allowed"), false);

  const reader: Actor = { ...writer, role: "reader" };
  assert.equal(canRead(reader, "default", "allowed"), true);
  assert.equal(canWrite(reader, "default", "allowed"), false);

  const admin: Actor = { ...writer, role: "admin" };
  assert.equal(canAdmin(admin, "default", "allowed"), true);
});
