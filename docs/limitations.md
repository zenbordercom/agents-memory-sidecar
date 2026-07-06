# Limitations

- Search defaults to keyword/full-text mode. Semantic and hybrid search require stored embeddings and an embedding model or explicit query embedding.
- The sidecar is designed for local agents, not public internet exposure.
- Fresh install automation is intentionally minimal.
- Secret scanning is a safety net, not complete DLP.
- Project naming discipline matters. Inconsistent project names reduce recall.
- Short targeted queries usually work better than long mixed-language prompts.

## Related Docs

- [Security Model](security-model.md)
- [Semantic And Hybrid Search](semantic-search.md)
- [Operations](operations.md)
