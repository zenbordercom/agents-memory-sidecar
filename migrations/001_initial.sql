CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_items (
  id uuid PRIMARY KEY,
  tenant text NOT NULL,
  project text NOT NULL,
  namespace text NOT NULL,
  kind text NOT NULL,
  title text,
  body text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  content_hash text,
  source_type text NOT NULL CHECK (source_type IN ('user', 'agent', 'file', 'command', 'url', 'system', 'manual', 'import')),
  source_ref text,
  agent_id text,
  runtime text,
  workspace text,
  visibility text NOT NULL DEFAULT 'team',
  importance integer NOT NULL DEFAULT 0,
  confidence numeric,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_content_hash_unique
  ON memory_items (tenant, project, namespace, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_items_scope_idx
  ON memory_items (tenant, project, namespace, kind);

CREATE INDEX IF NOT EXISTS memory_items_created_at_idx
  ON memory_items (created_at DESC);

CREATE INDEX IF NOT EXISTS memory_items_metadata_idx
  ON memory_items USING gin (metadata);

CREATE INDEX IF NOT EXISTS memory_items_fts_idx
  ON memory_items USING gin (
    to_tsvector('simple', coalesce(title, '') || ' ' || body || ' ' || coalesce(summary, ''))
  );

CREATE TABLE IF NOT EXISTS project_contexts (
  id uuid PRIMARY KEY,
  tenant text NOT NULL,
  project text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  source_ref text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, project, key)
);

CREATE TABLE IF NOT EXISTS agent_observations (
  id uuid PRIMARY KEY,
  tenant text NOT NULL,
  project text NOT NULL,
  agent_id text NOT NULL,
  runtime text,
  session_id text,
  observation text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  promoted_memory_id uuid REFERENCES memory_items(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_observations_scope_idx
  ON agent_observations (tenant, project, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  tenant text,
  actor text,
  agent_id text,
  runtime text,
  action text NOT NULL,
  target_type text,
  target_id text,
  project text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_scope_idx
  ON audit_events (tenant, project, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id uuid REFERENCES memory_items(id),
  embedding_model text NOT NULL,
  embedding vector,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, embedding_model)
);
