import type { Actor, SourceType } from "./types.js";
import type { MemorySearchInput, MemoryStore } from "./store.js";

export class HttpStore implements MemoryStore {
  constructor(
    private readonly baseUrl = process.env.AGENT_MEMORY_HTTP_BASE_URL ?? "http://127.0.0.1:18790",
    private readonly bearerToken = process.env.AGENT_MEMORY_HTTP_BEARER_TOKEN,
  ) {}

  async memorySearch(input: MemorySearchInput) {
    const result = await this.request("POST", "/v1/memory/search", input);
    return result.items;
  }

  async memoryGet(input: { tenant: string; project: string; id: string }) {
    return this.request(
      "GET",
      `/v1/memory/${encodeURIComponent(input.id)}?tenant=${encodeURIComponent(input.tenant)}&project=${encodeURIComponent(input.project)}`,
    );
  }

  async memoryAdd(
    _actor: Actor,
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
    return this.request("POST", "/v1/memory", input);
  }

  async contextGet(input: { tenant: string; project: string; keys?: string[] }) {
    const url = new URL(`${this.baseUrl}/v1/context`);
    url.searchParams.set("tenant", input.tenant);
    url.searchParams.set("project", input.project);
    for (const key of input.keys ?? []) {
      url.searchParams.append("key", key);
    }

    const result = await this.requestUrl("GET", url);
    return result.contexts;
  }

  async contextSet(
    _actor: Actor,
    input: {
      tenant: string;
      project: string;
      key: string;
      value: unknown;
      source_ref?: string;
      note?: string;
    },
  ) {
    const { key, ...body } = input;
    return this.request("PUT", `/v1/context/${encodeURIComponent(key)}`, body);
  }

  async observationAdd(
    _actor: Actor,
    input: {
      tenant: string;
      project: string;
      session_id?: string;
      observation: string;
      metadata?: Record<string, unknown>;
      ttl_days: number;
    },
  ) {
    return this.request("POST", "/v1/observations", input);
  }

  async auditEvent() {
    // The HTTP sidecar owns request-level auditing. The wrapper-side HttpStore
    // intentionally does not emit separate audit events to avoid duplicates.
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    return this.requestUrl(method, new URL(path, this.baseUrl), body);
  }

  private async requestUrl(method: string, url: URL, body?: unknown): Promise<any> {
    const response = await fetch(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${url.pathname} failed: ${response.status} ${JSON.stringify(json)}`);
    }
    return json;
  }
}
