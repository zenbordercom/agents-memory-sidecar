import { createStoreFromEnv } from "./store-factory.js";
import type { Actor } from "./types.js";

const actor: Actor = {
  tenant: "default",
  agentId: "seed-cli",
  runtime: "manual",
  workspace: process.cwd(),
  role: "admin",
  projects: ["*"],
};

const store = createStoreFromEnv();

async function main() {
  try {
    await store.contextSet(actor, {
    tenant: "default",
    project: "demo-app",
    key: "scope",
    value: {
      description: "Shared operational context for a demo application.",
      first_projects: ["demo-app", "server-ops"],
    },
    source_ref: "manual:seed",
    note: "Initial demo seed context",
  });

    await store.contextSet(actor, {
    tenant: "default",
    project: "demo-app",
    key: "deployment",
    value: {
      service: "demo-app.service",
      path: "/srv/demo-app",
      notes: "Replace this seed with facts about your own project.",
    },
    source_ref: "manual:seed",
  });

    await store.contextSet(actor, {
    tenant: "default",
    project: "server-ops",
    key: "runtime",
    value: {
      sidecar: "http://127.0.0.1:18790",
      note: "Keep secrets outside shared memory.",
    },
    source_ref: "manual:seed",
  });

    await store.memoryAdd(actor, {
    tenant: "default",
    project: "demo-app",
    namespace: "ops",
    kind: "deployment",
    title: "Demo app deployment note",
    body: "The demo application runs from /srv/demo-app and is managed by systemd. Replace this with your own stable project fact.",
    summary: "Demo deployment fact for local testing.",
    source_type: "manual",
    source_ref: "manual:seed",
    confidence: 1,
  });

    await store.memoryAdd(actor, {
    tenant: "default",
    project: "server-ops",
    namespace: "ops",
    kind: "troubleshooting",
    title: "Shared memory usage rule",
    body: "Agents should search project memory before changing known services and should store only stable non-secret facts after validation.",
    summary: "Search first, write stable non-secret facts after validation.",
    source_type: "manual",
    source_ref: "manual:seed",
    confidence: 1,
  });

    console.log("seed ok");
  } finally {
    await store.close?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
