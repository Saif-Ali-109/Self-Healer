# AGENTS.md — Self-Healer CI Agent

## What
Standalone Node.js daemon that watches CI failures (GitHub Actions), classifies them (`flaky`/`real_bug`/`infra`), auto-fixes allowlisted bugs via fix-only PRs (never merges), and escalates everything else.

## Architecture
| Concern | Implementation |
|---------|---------------|
| Language | TypeScript 5.7 strict, ESM, `node >= 22` |
| Database | `node:sqlite` (built into Node 22+, zero deps) |
| Git worktrees | Direct `git worktree add/remove` shell calls |
| SOR audit | Append-only hash-chain table in SQLite |
| Webhook | Standalone `node:http` server on `CI_WEBHOOK_PORT` (default `3457`) |
| Worker | Single FIFO worker, one failure at a time |
| LLM | Optional enrichment only; classifier is rule-first; ≤ 3 calls/failure |

## Key dirs
```
src/
  webhook/          HMAC-verified webhook server + GitHub Actions adapter
  pipeline/
    queue.ts        FIFO worker queue
    orchestrator.ts classification → fix/retry/escalation dispatch
    classifier/     rule-first flaky / infra / real_bug
    retry/          flaky rerun budget
    fixscope/       allowlist + lintfixer + importfixer
    escalation/     reasons → suggested next step
  audit/            run reconstruction
  db/               SQLite + migration runner (migrations 001–022)
```

## Commands
| Command | Purpose |
|---------|---------|
| `npm start` | Run webhook listener + worker daemon |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit + integration tests (DB-gated suites skip without `DATABASE_URL`) |
| `npm run migrate:up` | Apply migrations 001–022 |
| `npm run sor:verify` | Replay-verify SOR hash chain |
| `npm run audit:run -- <run-id>` | Reconstruct a past run |

## Fix-scope allowlist (active patterns)
- **`lint/format`** — auto-formats, verified with `npx @biomejs/biome check .`
- **`import/type`** — adds missing import for `ReferenceError: X`, verified with `node src/main.mjs`
- `snapshot` / `timeout` — registered but inactive stubs

## Delivery model (approve-then-fix)
1. Failing job matches allowlist → one fix in worktree → verified.
2. Pushed to `ci-fix/<run-id>` as a **fix-only PR**.
3. Comment posted on the failing run.
4. **Human merges.** Agent never merges.

## Guardrails
- `main`, `release/*`, `v*` are never auto-fixed.
- Webhook events from `ci-fix/*` branches are ignored (no loops).
- Repos must have `self-healer-notify.yml` to be watched.
- ≤ 1 fix attempt per failure. ≤ 3 flaky reruns. Confidence ≥ 0.7 to fix. 10-min pipeline budget.

## Packaging roadmap
Goal: standalone npm package (`self-healer-ci-agent`) or Docker image.
```bash
npm i -g self-healer-ci-agent
self-healer init        # creates .env + SQLite DB
self-healer enable --repo org/repo
self-healer start       # daemon on :3457
```
No Fleet clone, no PostgreSQL server, no extra dependencies.

## Out of scope
GitHub App form, multi-worker scaling, LLM enrichment beyond rule-first, dashboard UI, live demo re-run (after packaging completes).

## `.specify/`
- `.specify/memory/constitution.md` — governing contract (v1.3.0). All behavior decisions defer to this.
- `specs/001-self-healer-ci-agent/` — feature spec, plan, data model, contracts, tasks, quickstart.
- **Rule: update `.specify/` first; source code follows.**

## Language
Simple, direct. Keep explanations concise and concrete. Avoid heavy jargon unless asked.
