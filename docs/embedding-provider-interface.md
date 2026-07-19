# Embedding Provider Interface Proposal

This is a design proposal, not a stable public API and not an implementation of
additional providers.

## Goal

Separate embedding generation from PostgreSQL retrieval so a future provider
can be added without changing memory ownership, search authorization, vector
storage, or hybrid ranking.

```ts
type EmbeddingProvider = {
  id: string;
  embed(input: { model: string; texts: string[]; timeoutMs: number }): Promise<{
    model: string;
    dimensions: number;
    vectors: number[][];
  }>;
};
```

## Required Behavior

- A provider is selected only by explicit local configuration.
- Providers must return one finite vector per input text and a stable model id.
- The caller validates vector dimensions before writing `memory_embeddings`.
- Provider errors remain visible for semantic requests; hybrid may fall back to
  keyword only when no provider/model/query embedding was configured.
- Providers must not log texts, vectors, bearer tokens, or credentials.
- The existing Ollama implementation is the reference behavior for timeout and
  error handling.

## Non-Goals

- No remote provider is enabled by default.
- No provider credentials are stored in sidecar memory or token registries.
- No public plug-in ABI is promised in v0.3.0.

Implement another provider only when a concrete agent integration requires it
and can supply tests for model identity, dimensions, error behavior, and
credential handling.
