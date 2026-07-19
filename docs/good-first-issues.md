# Good First Issues

These candidates are intentionally bounded. Each has a clear owner surface,
test command, and review expectation.

1. Add `invalid_request` tests for every HTTP endpoint that accepts a numeric
   range (`limit` and `ttl_days`).
   Validation: `npm test` and `npm run coverage`.

2. Extend `docs/support-matrix.md` with a tested MCP client version after
   reproducing the documented integration flow.
   Validation: run the linked integration's memory search and memory add flow.

3. Add a non-sensitive benchmark fixture query with expected keyword relevance.
   Validation: run the documented search benchmark and update its expected
   result deliberately.

4. Improve an installation issue template using a real missing diagnostic
   field discovered during a public reproduction.
   Validation: the template must not request token values, passwords, or memory
   bodies.

Do not start work on an issue that changes authorization, token parsing,
migrations, or release publishing without maintainer discussion.
