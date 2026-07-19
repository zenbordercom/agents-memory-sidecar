import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeStore } from "./store.js";
import type { Actor } from "./types.js";

const actor: Actor = {
  tenant: "default",
  agentId: "store-test",
  runtime: "test",
  workspace: "/tmp",
  role: "writer",
  projects: ["*"],
};

test("FakeStore rejects duplicate content and isolates projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agents-memory-store-test-"));
  const store = new FakeStore(join(directory, "store.json"));
  const input = {
    tenant: "default",
    project: "project-a",
    namespace: "ops",
    kind: "note",
    title: "Runbook",
    body: "Restart the sidecar after rotating its token registry.",
    source_type: "manual" as const,
  };

  try {
    const first = await store.memoryAdd(actor, input);
    const duplicate = await store.memoryAdd(actor, input);
    assert.equal(first.accepted, true);
    assert.equal(duplicate.accepted, false);
    assert.deepEqual(duplicate.warnings, ["duplicate_content"]);

    const sameProject = await store.memorySearch({
      tenant: "default",
      project: "project-a",
      query: "rotating token",
      limit: 5,
    });
    const otherProject = await store.memorySearch({
      tenant: "default",
      project: "project-b",
      query: "rotating token",
      limit: 5,
    });
    assert.equal(sameProject.length, 1);
    assert.equal(otherProject.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
