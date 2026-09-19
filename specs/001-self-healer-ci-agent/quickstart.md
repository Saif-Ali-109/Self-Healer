# Quickstart: Self-Healer CI Agent (validation guide)

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

A runnable set of scenarios that prove the feature works end-to-end. This is a validation/run guide — implementation details live in `tasks.md` and the implementation phase.

## Prerequisites

- Node.js ≥ 22 and npm. No PostgreSQL, no Fleet clone required.
- A writable clone of the target repository at the same host (Self-Healer watches repos it can push to).
- Environment variables (see `.env.example`): `GH_TOKEN` (repo + actions:write + comment scope), `CI_WEBHOOK_SECRET`, `SOR_SIGNING_KEY`, LLM provider keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, or local `OLLAMA` endpoint — optional).
- `self-healer-notify.yml` present in the target repo (opt-in).

## Setup

```bash
npm install                      # Self-Healer deps (node:sqlite is built-in)
npm run migrate:up               # applies migrations 001–022 to the SQLite database
npm run start                    # starts daemon: webhook listener + single worker
```

Webhook listening on `POST /api/webhook/ci` (standalone server). The daemon also polls GitHub Actions for failed runs on watched repos.

## Validation scenarios

### Scenario A — Flaky failure recovers (P1, user story 2)

1. Given: a watched repo where a known-intermittent test occasionally fails.
2. When: the test fails on a CI run → agent receives webhook/poll, classifies `flaky`.
3. Then: retry runner reruns the job up to 3× via GitHub Actions API.
4. Expected outcome: job passes on a rerun → `ci_runs.status = resolved` → flaky-resolved comment posted on the run; no human action. Force persistent failure to observe `flaky_retries_exhausted` → escalation comment + `escalated` status.

**Check**: query `ci_runs` table → `status = resolved` or `escalated`.

### Scenario B — Lint/format real bug auto-fixed (P1, user story 3 — MVP fix path)

1. Given: a commit with an unfixable-adjacent-but-fixable lint/format failure pushed on a non-critical branch.
2. When: webhook/poll arrives → classifier `real_bug` (no flaky/infra signal), confidence ≥ 0.7, < 5 files, non-critical branch → guardrail matches `lint/format`.
3. Then: lintfixer runs formatter in the worktree, verifies (`npx @biomejs/biome check .` exits 0), commits to `ci-fix/<run-id>`, pushes, opens a fix-only PR, posts fix comment.
4. Expected outcome: comment with root cause + branch + diff summary + verification on the CI run; PR exists on origin; **no merge, nothing auto-merged**.

### Scenario C — Import/type real bug auto-fixed (P1, user story 3 — Tier 2)

1. Given: a commit where `renderWidget()` is called without importing it (→ `ReferenceError: renderWidget is not defined`).
2. When: webhook/poll arrives → classifier `real_bug`, confidence ≥ 0.7, matches `import/type`.
3. Then: importfixer finds the sole exporter (`renderer.mjs`), adds `import { renderWidget } from "./renderer.mjs"` in the worktree, verifies (`node src/main.mjs` exits 0), commits to `ci-fix/<run-id>`, pushes, opens a fix-only PR, posts fix comment.
4. Expected outcome: comment with `**Pattern matched**: import/type` + `**Verification**: node src/main.mjs: passed` + PR link on the CI run.

### Scenario D — No pattern match escalation (P1, user story 4)

1. Given: a failure that does not match any allowlist pattern.
2. When: classifier runs, no pattern matched.
3. Then: escalation with `reason: no_pattern_match` + suggested next step.

### Scenario E — Audit trail (P2, user story 5)

1. Given: any processed failure.
2. When: pipeline completes.
3. Then: `npm run sor:verify` reports `ok: yes` (tamper-free chain); `npm run audit:run -- <run-id>` reconstructs the full run history.

## Post-packaging validation (future)

```bash
npm i -g self-healer-ci-agent    # install the standalone package
self-healer init                  # creates .env + SQLite DB
self-healer enable --repo org/repo
self-healer start                 # daemon on :3457
```

No Fleet clone, no PostgreSQL server. All-in-one package.
