# VPS Project Management Handbook

Last updated: 2026-07-06
Owner: David
Primary machine: `/home/ubuntu` on VPS

## Purpose

This handbook defines how projects on this VPS are classified, maintained, and handed off between agents. It is intentionally operational: it tells an agent where to work, what must not be touched blindly, and what checks are expected before a change is considered done.

## Project Classes

### Primary Development Projects

These are normal development repositories. They should stay clean, pushed, and documented.

| Project | Path | Remote | Notes |
|---|---|---|---|
| Zen Wiki | `/home/ubuntu/apps/zen-wiki` | `zenbordercom/zen-wiki` | Primary VPS development source for zen-wiki. Use `main` for stable work and keep `origin/mac-migration-20260704` as migration archive. |
| Loop Engineering | `/home/ubuntu/loop-engineering` | `zenbordercom/loop-engineering` | Loop/orchestrator project. Run local tests before commit. |
| Agents Memory Sidecar | `/home/ubuntu/agents-memory-sidecar` | `zenbordercom/agents-memory-sidecar` | New shared memory sidecar codebase. |
| Agent Memory Sidecar | `/home/ubuntu/agent-memory-sidecar` | `zenbordercom/agent-memory-sidecar` | Current running production sidecar runtime source lineage. |
| Zen Site | `/home/ubuntu/zen-site` | `zenbordercom/zen-site` | Site/prototype work. |
| Baiban | `/home/ubuntu/baiban` | `zenbordercom/baiban` | Human-facing whiteboard workspace. Also see skill repo cache under `~/.agents/baiban/repo`. |
| Knowledge Vault | `/home/ubuntu/lab/obsidian-vault` | `zenbordercom/knowledge-engine` | Local knowledge-engine worktree. Review generated index diffs before commit. |
| AI Team OS | `/home/ubuntu/programming/ai-team-os` | none configured | Local content baseline. Treat as local-only unless remote is added. |

### Running Service Projects

These affect live services. Check systemd before and after changes.

| Service | Path | Unit | Notes |
|---|---|---|---|
| Server Dashboard | `/home/ubuntu/server-dashboard` | `server-dashboard.service` | Tailscale private ops dashboard on `127.0.0.1:3920`. |
| Silly Camel API | `/home/ubuntu/sillycamel-api` | `sillycamel-api.service` | Express subscribe API. Contains `subscribers.txt`; treat as private data. |
| Agent Memory Sidecar | `/home/ubuntu/agent-memory-sidecar` | `agent-memory-sidecar.service` | HTTP sidecar on localhost with PostgreSQL/pgvector. |

### Agent Tools And Skills

These are operational dependencies, not product projects.

| Asset | Path | Notes |
|---|---|---|
| Agent Team skill | `/home/ubuntu/.agents/skills/agent-team` | Git repo. Used for multi-agent workflows. |
| Baiban skill data repo | `/home/ubuntu/.agents/baiban/repo` | Private shared baiban repo cache. Use the baiban script, not manual edits, when possible. |
| Hermes agent | `/home/ubuntu/.hermes/hermes-agent` | Upstream `NousResearch/hermes-agent`. Large cache/log area lives under `.hermes`. |
| Codex/Claude/Grok/Gemini/OpenClaw homes | `~/.codex`, `~/.claude`, `~/.grok`, `~/.gemini`, `~/.openclaw` | Tool state, sessions, caches, and skills. Do not treat as normal application repos. |

### Archives And Snapshots

| Asset | Path | Rule |
|---|---|---|
| Zen Wiki Mac snapshot | `/home/ubuntu/imports/zen-wiki-mac-20260704` | Read-only migration reference. Do not rsync over the live repo. |
| Obsidian experiment backup | `/home/ubuntu/lab/obsidian-vault.orig.bak` | Local experiment copy with push disabled. Commit local notes if useful. |
| Claude site assets | `/home/ubuntu/claude` | Legacy scripts, logs, reports, and zip assets. Treat as archive unless explicitly maintaining a site. |
| Grok site checks | `/home/ubuntu/grok` | Daily site check reports and scripts. |

## Standard Start-Of-Work Checklist

For any repository:

```bash
cd <project>
git status --short --branch
git remote -v
git log --oneline -3
```

Rules:

- If the worktree is dirty, inspect the diff before editing.
- Do not reset, clean, or checkout over user changes unless explicitly instructed.
- Prefer small topic branches for product work.
- Push important commits before leaving the task.

## Verification Policy

Use project-native checks. Minimum expectations:

| Project | Checks |
|---|---|
| `zen-wiki` | `make lint`, `make check-paths`, `make check-docs`; for release/runtime work also `make release-check` and runtime build. |
| `loop-engineering` | `python3 -m pytest tests/ -q` where available. |
| `agents-memory-sidecar` | `npm run build`, `npm run smoke`, and relevant HTTP smoke tests if sidecar behavior changes. |
| `agent-memory-sidecar` | Same as repo docs; verify installed runtime separately if production behavior changes. |
| `server-dashboard` | `curl -s http://127.0.0.1:3920/health`, then `systemctl status server-dashboard`. |
| `sillycamel-api` | Node syntax/startup check; avoid printing or committing subscriber data. |
| `baiban` | Use the baiban skill script for shared memos; commit and push ordinary repo changes after review. |
| `obsidian-vault` | Treat generated index timestamp changes as normal only if caused by a deliberate compile/ingest run. |

## Dirty Worktree Policy

When a dirty repo is found:

1. Inspect `git status --short --branch`.
2. Inspect `git diff` and untracked files.
3. Classify the change:
   - generated refresh,
   - human-authored note,
   - service config,
   - private data,
   - accidental/cache output.
4. Commit useful changes with a narrow message.
5. Leave private data uncommitted unless the repo already owns it and policy allows.
6. Push only when the remote is intended to receive that branch.

## Current Known Dirty Areas As Of 2026-07-06

These were identified during the VPS project inventory:

- `/home/ubuntu/baiban`: `白板.md` contains a website and cron overview update.
- `/home/ubuntu/lab/obsidian-vault`: generated wiki index timestamps plus a Loop Engineering note.
- `/home/ubuntu/lab/obsidian-vault.orig.bak`: local `EXPERIMENT.md` describing the experiment copy rules.

## Do Not Do

- Do not copy the Mac `zen-wiki` snapshot over `/home/ubuntu/apps/zen-wiki`.
- Do not commit `.agent-team`, caches, session logs, or tool runtime state into product repos.
- Do not expose sidecar HTTP services publicly.
- Do not push from `obsidian-vault.orig.bak`; its push URL is intentionally disabled.
- Do not commit `sillycamel-api/subscribers.txt` unless explicitly instructed and privacy-reviewed.

## Recommended Weekly Maintenance

1. Run a Git status sweep for primary repos.
2. Commit or document useful dirty changes.
3. Check running units:

```bash
systemctl status agent-memory-sidecar server-dashboard sillycamel-api --no-pager
```

4. Confirm `zen-wiki` and sidecar repos are pushed.
5. Review disk-heavy tool dirs (`~/.hermes`, `~/.openclaw`, `~/.codex`, `~/.claude`) for cache cleanup only after confirming no active sessions depend on them.

## Canonical Inventory Snapshot

The latest manual inventory was performed on 2026-07-06. Re-run from `/home/ubuntu` with:

```bash
find /home/ubuntu -path '*/.git' -type d -prune 2>/dev/null | sed 's#/.git$##' | sort
du -sh /home/ubuntu/apps /home/ubuntu/imports /home/ubuntu/programming /home/ubuntu/lab /home/ubuntu/zen-site /home/ubuntu/loop-engineering /home/ubuntu/baiban /home/ubuntu/agent-memory-sidecar /home/ubuntu/agents-memory-sidecar /home/ubuntu/server-dashboard /home/ubuntu/sillycamel-api 2>/dev/null | sort -h
```
