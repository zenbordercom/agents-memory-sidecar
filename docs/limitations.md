# Limitations

- Search defaults to keyword/full-text mode. Semantic and hybrid search require stored embeddings and an embedding model or explicit query embedding.
- The sidecar is designed for local agents, not public internet exposure.
- Fresh install automation is intentionally minimal.
- Secret scanning is a safety net, not complete DLP. Matches are attributed by rule name (`suspected_secret:<rule>`); benign environment keys such as `PATH=` are whitelisted.
- The fake store writes atomically (temp file + rename) but does NOT support concurrent multi-process writers: last write wins on the whole file. Use the PostgreSQL backend when several processes share one store.
- Semantic search uses sequential scans by design. ANN indexing was evaluated and deliberately deferred - see the repair plan and `search:benchmark`; revisit only if measured scoped-search latency exceeds budget.
- Project naming discipline matters. Inconsistent project names reduce recall.
- Short targeted queries usually work better than long mixed-language prompts.

## Related Docs

- [Security Model](security-model.md)
- [Semantic And Hybrid Search](semantic-search.md)
- [Operations](operations.md)
