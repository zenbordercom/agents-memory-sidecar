import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Actor,
  AgentObservation,
  AuditEvent,
  FakeStoreData,
  MemoryItem,
  ProjectContext,
  SourceType,
} from "./types.js";

export type MemoryStore = {
  memorySearch(input: MemorySearchInput): Promise<unknown[]>;
  memoryGet(input: { tenant: string; project: string; id: string }): Promise<MemoryItem | undefined>;
  memoryAdd(actor: Actor, input: {
    tenant: string;
    project: string;
    namespace: string;
    kind: string;
    title?: string;
    body: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    source_type: SourceType;
    source_ref?: string;
    confidence?: number;
  }): Promise<{ id: string; accepted: boolean; warnings: string[] }>;
  contextGet(input: { tenant: string; project: string; keys?: string[] }): Promise<ProjectContext[]>;
  contextSet(actor: Actor, input: {
    tenant: string;
    project: string;
    key: string;
    value: unknown;
    source_ref?: string;
    note?: string;
  }): Promise<{ key: string; accepted: boolean; warnings: string[]; updated_at: string }>;
  observationAdd(actor: Actor, input: {
    tenant: string;
    project: string;
    session_id?: string;
    observation: string;
    metadata?: Record<string, unknown>;
    ttl_days: number;
  }): Promise<{ id: string; accepted: boolean; warnings: string[] }>;
  auditEvent(input: {
    tenant?: string;
    actor?: Actor;
    action: string;
    target_type?: string;
    target_id?: string;
    project?: string;
    request_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  close?(): Promise<void>;
};

export type SearchMode = "keyword" | "semantic" | "hybrid";

export type MemorySearchInput = {
  tenant: string;
  project: string;
  query: string;
  namespace?: string;
  kind?: string;
  limit: number;
  mode?: SearchMode;
  embedding_model?: string;
  query_embedding?: number[];
};

const emptyData: FakeStoreData = {
  memory_items: [],
  project_contexts: [],
  agent_observations: [],
  audit_events: [],
};

export class FakeStore implements MemoryStore {
  private loaded = false;
  private data: FakeStoreData = structuredClone(emptyData);

  constructor(private readonly path: string) {}

  static fromEnv(): FakeStore {
    return new FakeStore(
      resolve(process.env.AGENT_MEMORY_STORE_PATH ?? "data/fake-store.json"),
    );
  }

  async memorySearch(input: MemorySearchInput) {
    await this.load();
    const query = input.query.trim().toLowerCase();
    const now = Date.now();

    return this.data.memory_items
      .filter((item) => item.tenant === input.tenant)
      .filter((item) => item.project === input.project)
      .filter((item) => !item.deleted_at)
      .filter((item) => !item.expires_at || Date.parse(item.expires_at) > now)
      .filter((item) => !input.namespace || item.namespace === input.namespace)
      .filter((item) => !input.kind || item.kind === input.kind)
      .map((item) => ({
        item,
        score: scoreMemory(item, query),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit)
      .map(({ item }) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        body_excerpt: excerpt(item.body, query),
        kind: item.kind,
        project: item.project,
        namespace: item.namespace,
        source_type: item.source_type,
        source_ref: item.source_ref,
        confidence: item.confidence,
        created_at: item.created_at,
      }));
  }

  async memoryGet(input: { tenant: string; project: string; id: string }) {
    await this.load();
    const now = Date.now();
    return this.data.memory_items.find(
      (item) =>
        item.id === input.id &&
        item.tenant === input.tenant &&
        item.project === input.project &&
        !item.deleted_at &&
        (!item.expires_at || Date.parse(item.expires_at) > now),
    );
  }

  async memoryAdd(
    actor: Actor,
    input: {
      tenant: string;
      project: string;
      namespace: string;
      kind: string;
      title?: string;
      body: string;
      summary?: string;
      metadata?: Record<string, unknown>;
      source_type: SourceType;
      source_ref?: string;
      confidence?: number;
    },
  ) {
    await this.load();
    const now = new Date().toISOString();
    const contentHash = hashContent(input.title, input.summary, input.body);
    const existing = this.data.memory_items.find(
      (item) =>
        item.tenant === input.tenant &&
        item.project === input.project &&
        item.namespace === input.namespace &&
        item.content_hash === contentHash &&
        !item.deleted_at,
    );

    if (existing) {
      await this.audit(actor, "memory.duplicate", "memory_item", existing.id, input.project, {
        content_hash: contentHash,
      });
      return {
        id: existing.id,
        accepted: false,
        warnings: ["duplicate_content"],
      };
    }

    const item: MemoryItem = {
      id: randomUUID(),
      tenant: input.tenant,
      project: input.project,
      namespace: input.namespace,
      kind: input.kind,
      title: input.title,
      body: input.body,
      summary: input.summary,
      metadata: input.metadata ?? {},
      content_hash: contentHash,
      source_type: input.source_type,
      source_ref: input.source_ref,
      agent_id: actor.agentId,
      runtime: actor.runtime,
      workspace: actor.workspace,
      visibility: "team",
      importance: 0,
      confidence: input.confidence,
      created_at: now,
      updated_at: now,
    };

    this.data.memory_items.push(item);
    await this.audit(actor, "memory.add", "memory_item", item.id, input.project, {
      namespace: input.namespace,
      kind: input.kind,
      source_type: input.source_type,
    });
    await this.save();

    return {
      id: item.id,
      accepted: true,
      warnings: [],
    };
  }

  async contextGet(input: { tenant: string; project: string; keys?: string[] }) {
    await this.load();
    return this.data.project_contexts
      .filter((context) => context.tenant === input.tenant)
      .filter((context) => context.project === input.project)
      .filter((context) => !input.keys?.length || input.keys.includes(context.key))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async contextSet(
    actor: Actor,
    input: {
      tenant: string;
      project: string;
      key: string;
      value: unknown;
      source_ref?: string;
      note?: string;
    },
  ) {
    await this.load();
    const now = new Date().toISOString();
    let context = this.data.project_contexts.find(
      (item) =>
        item.tenant === input.tenant &&
        item.project === input.project &&
        item.key === input.key,
    );

    if (!context) {
      context = {
        id: randomUUID(),
        tenant: input.tenant,
        project: input.project,
        key: input.key,
        value: input.value,
        source_ref: input.source_ref,
        updated_by: actor.agentId,
        updated_at: now,
      };
      this.data.project_contexts.push(context);
    } else {
      context.value = input.value;
      context.source_ref = input.source_ref;
      context.updated_by = actor.agentId;
      context.updated_at = now;
    }

    await this.audit(actor, "context.set", "project_context", context.id, input.project, {
      key: input.key,
      note: input.note,
    });
    await this.save();

    return {
      key: context.key,
      accepted: true,
      warnings: [],
      updated_at: context.updated_at,
    };
  }

  async observationAdd(
    actor: Actor,
    input: {
      tenant: string;
      project: string;
      session_id?: string;
      observation: string;
      metadata?: Record<string, unknown>;
      ttl_days: number;
    },
  ) {
    await this.load();
    const now = new Date();
    const observation: AgentObservation = {
      id: randomUUID(),
      tenant: input.tenant,
      project: input.project,
      agent_id: actor.agentId,
      runtime: actor.runtime,
      session_id: input.session_id,
      observation: input.observation,
      metadata: input.metadata ?? {},
      expires_at: new Date(now.getTime() + input.ttl_days * 86_400_000).toISOString(),
      created_at: now.toISOString(),
    };

    this.data.agent_observations.push(observation);
    await this.audit(actor, "observation.add", "agent_observation", observation.id, input.project, {
      ttl_days: input.ttl_days,
    });
    await this.save();

    return {
      id: observation.id,
      accepted: true,
      warnings: [],
    };
  }

  private async audit(
    actor: Actor,
    action: string,
    targetType: string,
    targetId: string,
    project: string,
    metadata: Record<string, unknown>,
  ) {
    await this.auditEvent({
      tenant: actor.tenant,
      actor,
      action,
      target_type: targetType,
      target_id: targetId,
      project,
      metadata,
    });
  }

  async auditEvent(input: {
    tenant?: string;
    actor?: Actor;
    action: string;
    target_type?: string;
    target_id?: string;
    project?: string;
    request_id?: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.load();
    const event: AuditEvent = {
      id: randomUUID(),
      tenant: input.tenant,
      actor: input.actor ? `${input.actor.runtime}:${input.actor.agentId}` : undefined,
      agent_id: input.actor?.agentId,
      runtime: input.actor?.runtime,
      action: input.action,
      target_type: input.target_type,
      target_id: input.target_id,
      project: input.project,
      request_id: input.request_id ?? randomUUID(),
      metadata: input.metadata ?? {},
      created_at: new Date().toISOString(),
    };

    this.data.audit_events.push(event);
    await this.save();
  }

  private async load() {
    if (this.loaded) {
      return;
    }

    try {
      this.data = JSON.parse(await readFile(this.path, "utf8")) as FakeStoreData;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.data = structuredClone(emptyData);
      await this.save();
    }

    this.loaded = true;
  }

  private async save() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.path);
  }
}

function hashContent(title: string | undefined, summary: string | undefined, body: string): string {
  const normalized = [title ?? "", summary ?? "", body]
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

function scoreMemory(item: MemoryItem, query: string): number {
  const haystack = [item.title ?? "", item.summary ?? "", item.body, item.kind, item.namespace]
    .join("\n")
    .toLowerCase();
  if (!query) {
    return 1;
  }

  let score = 0;
  if (item.title?.toLowerCase().includes(query)) score += 8;
  if (item.summary?.toLowerCase().includes(query)) score += 4;
  if (item.body.toLowerCase().includes(query)) score += 2;

  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) score += 1;
  }

  return score;
}

function excerpt(body: string, query: string, size = 280): string {
  if (!query) {
    return body.slice(0, size);
  }

  const index = body.toLowerCase().indexOf(query);
  if (index === -1) {
    return body.slice(0, size);
  }

  const start = Math.max(0, index - Math.floor(size / 3));
  return body.slice(start, start + size);
}
