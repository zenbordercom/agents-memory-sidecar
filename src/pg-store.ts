import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Actor, MemoryItem, ProjectContext, SourceType } from "./types.js";
import type { MemorySearchInput, MemoryStore, SearchMode } from "./store.js";

export class PgStore implements MemoryStore {
  constructor(private readonly pool: Pool) {}

  async close() {
    await this.pool.end();
  }

  async memorySearch(input: MemorySearchInput) {
    const mode = searchMode(input.mode);
    if (mode !== "keyword") {
      const embedding = input.query_embedding ?? await queryEmbedding(input.query);
      const model = input.embedding_model ?? process.env.AGENT_MEMORY_EMBEDDING_MODEL;
      if (embedding?.length && model) {
        return mode === "semantic"
          ? this.semanticSearch(input, model, embedding)
          : this.hybridSearch(input, model, embedding);
      }
      if (input.mode === "semantic") {
        throw new Error("semantic search requires embedding_model and query_embedding or AGENT_MEMORY_EMBEDDING_MODEL");
      }
    }

    return this.keywordSearch(input);
  }

  private async keywordSearch(input: MemorySearchInput) {
    const params: unknown[] = [input.tenant, input.project, input.query, input.limit];
    const filters = [
      "tenant = $1",
      "project = $2",
      "deleted_at IS NULL",
      "(expires_at IS NULL OR expires_at > now())",
    ];
    let next = 5;

    if (input.namespace) {
      filters.push(`namespace = $${next++}`);
      params.push(input.namespace);
    }

    if (input.kind) {
      filters.push(`kind = $${next++}`);
      params.push(input.kind);
    }

    const result = await this.pool.query(
      `
      SELECT
        id, title, summary,
        ts_headline('simple', body, plainto_tsquery('simple', $3), 'MaxWords=40, MinWords=12') AS body_excerpt,
        kind, project, namespace, source_type, source_ref, confidence, created_at
      FROM memory_items
      WHERE ${filters.join(" AND ")}
        AND to_tsvector('simple', coalesce(title, '') || ' ' || body || ' ' || coalesce(summary, ''))
          @@ plainto_tsquery('simple', $3)
      ORDER BY ts_rank(
        to_tsvector('simple', coalesce(title, '') || ' ' || body || ' ' || coalesce(summary, '')),
        plainto_tsquery('simple', $3)
      ) DESC, created_at DESC
      LIMIT $4
      `,
      params,
    );

    return result.rows.map((row) => ({
      ...row,
      created_at: toIso(row.created_at),
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      search_mode: "keyword",
    }));
  }

  private async semanticSearch(input: MemorySearchInput, model: string, embedding: number[]) {
    const params: unknown[] = [
      input.tenant,
      input.project,
      input.query,
      input.limit,
      model,
      vectorLiteral(embedding),
    ];
    const filters = [
      "mi.tenant = $1",
      "mi.project = $2",
      "mi.deleted_at IS NULL",
      "(mi.expires_at IS NULL OR mi.expires_at > now())",
      "me.embedding_model = $5",
      "vector_dims(me.embedding) = vector_dims($6::vector)",
    ];
    let next = 7;

    if (input.namespace) {
      filters.push(`mi.namespace = $${next++}`);
      params.push(input.namespace);
    }

    if (input.kind) {
      filters.push(`mi.kind = $${next++}`);
      params.push(input.kind);
    }

    const result = await this.pool.query(
      `
      SELECT
        mi.id, mi.title, mi.summary,
        ts_headline('simple', mi.body, plainto_tsquery('simple', $3), 'MaxWords=40, MinWords=12') AS body_excerpt,
        mi.kind, mi.project, mi.namespace, mi.source_type, mi.source_ref, mi.confidence, mi.created_at,
        1 - (me.embedding <=> $6::vector) AS semantic_score
      FROM memory_items mi
      JOIN memory_embeddings me ON me.memory_id = mi.id
      WHERE ${filters.join(" AND ")}
      ORDER BY me.embedding <=> $6::vector ASC, mi.created_at DESC
      LIMIT $4
      `,
      params,
    );

    return result.rows.map((row) => ({
      ...row,
      created_at: toIso(row.created_at),
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      semantic_score: row.semantic_score === null ? undefined : Number(row.semantic_score),
      search_mode: "semantic",
      embedding_model: model,
    }));
  }

  private async hybridSearch(input: MemorySearchInput, model: string, embedding: number[]) {
    const params: unknown[] = [
      input.tenant,
      input.project,
      input.query,
      input.limit,
      model,
      vectorLiteral(embedding),
    ];
    const filters = [
      "mi.tenant = $1",
      "mi.project = $2",
      "mi.deleted_at IS NULL",
      "(mi.expires_at IS NULL OR mi.expires_at > now())",
    ];
    let next = 7;

    if (input.namespace) {
      filters.push(`mi.namespace = $${next++}`);
      params.push(input.namespace);
    }

    if (input.kind) {
      filters.push(`mi.kind = $${next++}`);
      params.push(input.kind);
    }

    const result = await this.pool.query(
      `
      WITH ranked AS (
        SELECT
          mi.id, mi.title, mi.summary,
          ts_headline('simple', mi.body, plainto_tsquery('simple', $3), 'MaxWords=40, MinWords=12') AS body_excerpt,
          mi.kind, mi.project, mi.namespace, mi.source_type, mi.source_ref, mi.confidence, mi.created_at,
          ts_rank(
            to_tsvector('simple', coalesce(mi.title, '') || ' ' || mi.body || ' ' || coalesce(mi.summary, '')),
            plainto_tsquery('simple', $3)
          ) AS keyword_score,
          CASE
            WHEN me.embedding IS NULL THEN NULL
            ELSE 1 - (me.embedding <=> $6::vector)
          END AS semantic_score
        FROM memory_items mi
        LEFT JOIN memory_embeddings me
          ON me.memory_id = mi.id
         AND me.embedding_model = $5
         AND vector_dims(me.embedding) = vector_dims($6::vector)
        WHERE ${filters.join(" AND ")}
      )
      SELECT *
      FROM ranked
      WHERE keyword_score > 0 OR semantic_score IS NOT NULL
      ORDER BY (keyword_score + (0.7 * greatest(coalesce(semantic_score, 0), 0))) DESC, created_at DESC
      LIMIT $4
      `,
      params,
    );

    return result.rows.map((row) => ({
      ...row,
      created_at: toIso(row.created_at),
      confidence: row.confidence === null ? undefined : Number(row.confidence),
      keyword_score: row.keyword_score === null ? undefined : Number(row.keyword_score),
      semantic_score: row.semantic_score === null ? undefined : Number(row.semantic_score),
      search_mode: "hybrid",
      embedding_model: model,
    }));
  }

  async memoryGet(input: { tenant: string; project: string; id: string }) {
    const result = await this.pool.query(
      `
      SELECT *
      FROM memory_items
      WHERE id = $1
        AND tenant = $2
        AND project = $3
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      `,
      [input.id, input.tenant, input.project],
    );

    return result.rows[0] ? memoryRow(result.rows[0]) : undefined;
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
    const contentHash = hashContent(input.title, input.summary, input.body);

    // Fast path: pre-existing duplicate without racing another writer.
    const existingId = await this.findActiveMemoryId(input.tenant, input.project, input.namespace, contentHash);
    if (existingId) {
      await this.audit(actor, "memory.duplicate", "memory_item", existingId, input.project, {
        content_hash: contentHash,
      });
      return { id: existingId, accepted: false, warnings: ["duplicate_content"] };
    }

    // Race-safe path: rely on the partial unique index via ON CONFLICT. The
    // inference must repeat the index predicate exactly (partial unique index
    // on tenant/project/namespace/content_hash WHERE content_hash IS NOT NULL
    // AND deleted_at IS NULL); a bare DO NOTHING would not hit the arbiter.
    // On conflict the winner row may itself be soft-deleted concurrently, so
    // retry a bounded number of times before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.pool.query(
        `
        INSERT INTO memory_items (
          id, tenant, project, namespace, kind, title, body, summary, metadata, content_hash,
          source_type, source_ref, agent_id, runtime, workspace, visibility, importance, confidence
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'team', 0, $16)
        ON CONFLICT (tenant, project, namespace, content_hash)
          WHERE content_hash IS NOT NULL AND deleted_at IS NULL
        DO NOTHING
        RETURNING id
        `,
        [
          randomUUID(),
          input.tenant,
          input.project,
          input.namespace,
          input.kind,
          input.title,
          input.body,
          input.summary,
          input.metadata ?? {},
          contentHash,
          input.source_type,
          input.source_ref,
          actor.agentId,
          actor.runtime,
          actor.workspace,
          input.confidence,
        ],
      );

      if (inserted.rows[0]) {
        const id = inserted.rows[0].id as string;
        await this.audit(actor, "memory.add", "memory_item", id, input.project, {
          namespace: input.namespace,
          kind: input.kind,
          source_type: input.source_type,
        });
        return { id, accepted: true, warnings: [] };
      }

      // Lost the insert race: report the winner's id as a duplicate.
      const winnerId = await this.findActiveMemoryId(input.tenant, input.project, input.namespace, contentHash);
      if (winnerId) {
        await this.audit(actor, "memory.duplicate", "memory_item", winnerId, input.project, {
          content_hash: contentHash,
        });
        return { id: winnerId, accepted: false, warnings: ["duplicate_content"] };
      }
      // Winner was soft-deleted between conflict and lookup; retry the insert.
    }

    throw new Error("memory_add_conflict_retry_exhausted");
  }

  private async findActiveMemoryId(
    tenant: string,
    project: string,
    namespace: string,
    contentHash: string,
  ): Promise<string | undefined> {
    const existing = await this.pool.query(
      `
      SELECT id
      FROM memory_items
      WHERE tenant = $1 AND project = $2 AND namespace = $3 AND content_hash = $4 AND deleted_at IS NULL
      LIMIT 1
      `,
      [tenant, project, namespace, contentHash],
    );
    return existing.rows[0]?.id as string | undefined;
  }

  async contextGet(input: { tenant: string; project: string; keys?: string[] }) {
    const params: unknown[] = [input.tenant, input.project];
    const filters = ["tenant = $1", "project = $2"];

    if (input.keys?.length) {
      params.push(input.keys);
      filters.push(`key = ANY($${params.length})`);
    }

    const result = await this.pool.query(
      `
      SELECT *
      FROM project_contexts
      WHERE ${filters.join(" AND ")}
      ORDER BY key
      `,
      params,
    );

    return result.rows.map(contextRow);
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
    const id = randomUUID();
    const result = await this.pool.query(
      `
      INSERT INTO project_contexts (id, tenant, project, key, value, source_ref, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant, project, key)
      DO UPDATE SET value = EXCLUDED.value, source_ref = EXCLUDED.source_ref, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING id, key, updated_at
      `,
      [id, input.tenant, input.project, input.key, input.value, input.source_ref, actor.agentId],
    );

    await this.audit(actor, "context.set", "project_context", result.rows[0].id, input.project, {
      key: input.key,
      note: input.note,
    });

    return {
      key: result.rows[0].key,
      accepted: true,
      warnings: [],
      updated_at: toIso(result.rows[0].updated_at),
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
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO agent_observations (
        id, tenant, project, agent_id, runtime, session_id, observation, metadata, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9::int * interval '1 day'))
      `,
      [
        id,
        input.tenant,
        input.project,
        actor.agentId,
        actor.runtime,
        input.session_id,
        input.observation,
        input.metadata ?? {},
        input.ttl_days,
      ],
    );
    await this.audit(actor, "observation.add", "agent_observation", id, input.project, {
      ttl_days: input.ttl_days,
    });

    return { id, accepted: true, warnings: [] };
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
    await this.pool.query(
      `
      INSERT INTO audit_events (
        id, tenant, actor, agent_id, runtime, action, target_type, target_id, project, request_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        randomUUID(),
        input.tenant,
        input.actor ? `${input.actor.runtime}:${input.actor.agentId}` : undefined,
        input.actor?.agentId,
        input.actor?.runtime,
        input.action,
        input.target_type,
        input.target_id,
        input.project,
        input.request_id ?? randomUUID(),
        input.metadata ?? {},
      ],
    );
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

function memoryRow(row: any): MemoryItem {
  return {
    ...row,
    metadata: row.metadata ?? {},
    confidence: row.confidence === null ? undefined : Number(row.confidence),
    expires_at: toOptionalIso(row.expires_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    deleted_at: toOptionalIso(row.deleted_at),
  };
}

function contextRow(row: any): ProjectContext {
  return {
    ...row,
    updated_at: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toOptionalIso(value: Date | string | null): string | undefined {
  if (!value) return undefined;
  return toIso(value);
}

function searchMode(mode?: SearchMode): SearchMode {
  const configured = mode ?? process.env.AGENT_MEMORY_SEARCH_MODE ?? "keyword";
  if (configured === "keyword" || configured === "semantic" || configured === "hybrid") {
    return configured;
  }
  throw new Error(`Invalid search mode: ${configured}`);
}

function vectorLiteral(values: number[]): string {
  if (!values.length || !values.every((value) => Number.isFinite(value))) {
    throw new Error("query_embedding must contain at least one finite number");
  }
  return `[${values.join(",")}]`;
}

async function queryEmbedding(query: string): Promise<number[] | undefined> {
  const model = process.env.AGENT_MEMORY_EMBEDDING_MODEL;
  if (!model) return undefined;

  const baseUrl = (process.env.AGENT_MEMORY_EMBEDDING_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const timeoutMs = Number(process.env.AGENT_MEMORY_EMBEDDING_TIMEOUT_MS ?? "30000");
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      input: [query],
      truncate: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama /api/embed failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  const embedding = json.embeddings?.[0];
  if (!Array.isArray(embedding)) {
    throw new Error("Ollama response did not include embeddings[0]");
  }
  return embedding;
}
