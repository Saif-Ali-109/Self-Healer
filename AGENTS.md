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
| LLM | AI repair agent (Gemini/OpenRouter/Ollama); classifier stays rule-first; ≤ 40 calls / ≤ 80 tools / 20 min per run |

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
  db/               SQLite + migration runner (migrations 001–024)
  cli/              self-healer commands: init / enable / start / status
  paths.ts          package-root resolution (migrations/, assets/, dist/)
```

## Commands
| Command | Purpose |
|---------|---------|
| `npm start` | Run webhook listener + worker daemon |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit + integration tests (DB-gated suites skip without `DATABASE_URL`) |
| `npm run migrate:up` | Apply migrations 001–024 |
| `npm run sor:verify` | Replay-verify SOR hash chain |
| `npm run audit:run -- <run-id>` | Reconstruct a past run |
| `npm run build` | Bundle CLI + daemon to `dist/` (esbuild, build-time only) |
| `node bin/self-healer.mjs <cmd>` | Run the built CLI directly (dev) |

## Fix-scope allowlist (active patterns)
- **`lint/format`** — auto-formats, verified with `npx @biomejs/biome check .`
- **`import/type`** — adds missing import for `ReferenceError: X`, verified with `node src/main.mjs`
- `snapshot` / `timeout` — registered but inactive stubs

## Delivery model (approve-then-fix)
1. Failing job is classified `real_bug` → the AI agent fixes it in one worktree, verified by the full suite (constitution v3.0.0).
2. Pushed to `ci-fix/<run-id>` (never forced) as a **best-effort fix-only PR** to the failing branch; if the PR can't open, delivery falls back to branch + CI comment.
3. Comment posted on the failing run (root cause, reasoning, diff summary, verification, PR link).
4. **Human merges.** Agent never merges, never touches protected branches.

## Guardrails
- `main`, `release/*`, `v*` are never auto-fixed.
- Webhook events from `ci-fix/*` branches are ignored (no loops).
- Repos must have `self-healer-notify.yml` to be watched.
- ≤ 1 fix attempt per failure. ≤ 3 flaky reruns. Confidence ≥ 0.7 to fix. 20-min pipeline budget (≤ 40 LLM calls / ≤ 80 tools).

## Packaging roadmap
Goal: standalone npm package (`self-healer-ci-agent`) or Docker image.
```bash
npm i -g self-healer-ci-agent
self-healer init        # creates .env + SQLite DB
self-healer enable --repo org/repo   # reporter PR + register watched
self-healer status      # db / queue / watched / SOR chain
self-healer start       # daemon on :3457
```
No Fleet clone, no PostgreSQL server. **Zero runtime dependencies**: source is
bundled to plain JS (`dist/`, esbuild is a build-time devDependency) so the
package installs and runs anywhere with Node ≥ 22.18. Migrations, the reporter
template (`assets/self-healer-notify.yml`) and `.env.example` ship with the
package; `bin/self-healer.mjs` pins the package root so `init` finds them from
any working directory.

## Out of scope
GitHub App form, multi-worker scaling, LLM enrichment beyond rule-first, dashboard UI, live demo re-run (after packaging completes).

## `.specify/`
- `.specify/memory/constitution.md` — governing contract (v3.0.0). All behavior decisions defer to this.
- `specs/001-self-healer-ci-agent/` — feature spec, plan, data model, contracts, tasks, quickstart.
- **Rule: update `.specify/` first; source code follows.**

## Secrets handling (house rule — binding on every agent session)
- **Never open, read, print, or dump `.env` (or any secrets file) — not values, not masked/partial values, not even a full listing of its keys from its contents.**
- **Enforced at the harness layer**: `opencode.jsonc` in this project sets `permissions` with hard `deny` rules for `read`, `edit`, and `shell` resources matching `.env*` (except `.env.example`). These denies cannot be overridden by approvals or my own discretion.
- Never run commands that reveal secrets: no `cat`/`read`/`tail`/`less`/`sed`/`awk`/`grep` on `.env`, no `source .env && echo $VAR`, no `cp`/`mv` of it, no `node/tsx --env-file=...` typed directly.
- Do not reference `.env` in shell command text at all (the deny pattern matches any command string containing `.env`).
- Secrets flow only through the app's own loader (`tsx --env-file-if-exists=.env` inside npm scripts, daemon/CLI env loading). Never echo what the loader provided.
- `.env` is gitignored and untracked; never stage, copy, or move it anywhere.

## Language
Simple, direct. Keep explanations concise and concrete. Avoid heavy jargon unless asked.
