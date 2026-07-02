export type Role = "reader" | "writer" | "admin";

export type Actor = {
  tenant: string;
  agentId: string;
  runtime: string;
  workspace?: string;
  role: Role;
  projects: string[];
};

export type SourceType =
  | "user"
  | "agent"
  | "file"
  | "command"
  | "url"
  | "system"
  | "manual"
  | "import";

export type MemoryItem = {
  id: string;
  tenant: string;
  project: string;
  namespace: string;
  kind: string;
  title?: string;
  body: string;
  summary?: string;
  metadata: Record<string, unknown>;
  content_hash: string;
  source_type: SourceType;
  source_ref?: string;
  agent_id: string;
  runtime: string;
  workspace?: string;
  visibility: "team";
  importance: number;
  confidence?: number;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
};

export type ProjectContext = {
  id: string;
  tenant: string;
  project: string;
  key: string;
  value: unknown;
  source_ref?: string;
  updated_by: string;
  updated_at: string;
};

export type AgentObservation = {
  id: string;
  tenant: string;
  project: string;
  agent_id: string;
  runtime: string;
  session_id?: string;
  observation: string;
  metadata: Record<string, unknown>;
  expires_at: string;
  promoted_memory_id?: string;
  created_at: string;
};

export type AuditEvent = {
  id: string;
  tenant?: string;
  actor?: string;
  agent_id?: string;
  runtime?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  project?: string;
  request_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type FakeStoreData = {
  memory_items: MemoryItem[];
  project_contexts: ProjectContext[];
  agent_observations: AgentObservation[];
  audit_events: AuditEvent[];
};
