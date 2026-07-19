# Memory Governance

This guide defines naming and lifecycle conventions for durable shared memory.
It is an operator policy, not a new HTTP administration API.

## Project And Namespace Naming

- Use one lowercase, stable project identifier per codebase or operational
  system, such as `agents-memory-sidecar` or `billing-api`.
- Do not use hostnames, branch names, dates, or agent session ids as projects.
- Use short namespaces for the type of durable knowledge: `ops`, `incident`,
  `architecture`, `convention`, `release`, or `governance`.
- Keep `kind` specific to the record, such as `runbook`, `decision`, `note`, or
  `incident`. Namespace answers where a fact belongs; kind answers what it is.

## Write And Duplicate Policy

The store rejects active records with the same normalized title, summary, and
body in one tenant/project/namespace, returning `duplicate_content`. Treat this
as a prompt to search and correct the existing memory rather than creating near
duplicates.

## Correction And Summary Updates

Use the operator-only maintenance script to update a summary. It checks the
target's tenant and project, scans the new summary for secrets, supports
`--dry-run`, and records an audit event:

```bash
node scripts/admin-memory-maintenance.mjs update-summary \
  --project billing-api \
  --id MEMORY_ID \
  --summary 'Current deployment convention uses blue/green rollback.' \
  --reason 'Runbook correction'
```

## Soft Deletion

Do not overwrite obsolete durable memories with empty content. Soft-delete them
with a reason so ordinary reads and searches stop returning the item while the
audit trail remains available:

```bash
node scripts/admin-memory-maintenance.mjs soft-delete \
  --project billing-api \
  --id MEMORY_ID \
  --reason 'Superseded by deployment-v2 runbook'
```

## Observation Expiry And Audit Review

Observations are short-lived and require `ttl_days`. The local maintenance
timer runs `scripts/prune-observations.mjs`, which deletes expired observations
and writes an `observation.prune` audit event. Use `--dry-run` before changing
timer configuration.

Review `audit_events` after token rotation, permission denials, duplicate
rejection, correction, soft deletion, and pruning. Request logs and audit
metadata are intended for accountability; they must not contain memory bodies
or bearer tokens.

## Administrative Boundary

Summary correction and soft deletion remain operator-only scripts in v0.3.0.
They are deliberately not exposed through MCP or HTTP because that would add a
new remote administrative attack surface. A future admin API requires separate
authentication, authorization, audit, and recovery design.
