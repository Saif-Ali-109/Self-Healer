# Quickstart: Self-Healer CI Agent (validation guide)

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

A runnable set of scenarios that prove the feature works end-to-end. This is a validation/run guide — implementation details live in `tasks.md` and the implementation phase.

## Prerequisites

- Node.js ≥ 22, npm, and a PostgreSQL instance (Fleet's existing DB).
- A writable clone of the target repository at the same host (Self-Healer watches repos it can push to).
- Environment variables (see `.env.example`): `GH_TOKEN` (repo + actions:write + comment scope), `CI_WEBHOOK_SECRET`, `DATABASE_URL`, LLM provider keys (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, or local `OLLAMA` endpoint).
- The local `fleet/` clone present (path alias dependency).

## Setup

```bash
npm install                      # Self-Healer deps (+ fleet dev deps via alias)
npm run migrate:up               # applies Fleet migrations 001–016 + new 017–020
npm run start                    # starts daemon: dashboard server + webhook listener + single worker
```

Webhook listening on `POST /api/webhook/ci` (Fleet dashboard server).

## Validation scenarios

### Scenario A — Flaky failure recovers (P1, user story 2)

1. **Given**: a watched repo where a known-intermittent test occasionally fails.
2. **When**: the test fails on a CI run → agent receives webhook, classifies `flaky` (evidence: passed on previous run / timing pattern).
3. **Then**: retry runner reruns the job up to 3× via platform API.
4. **Expected outcome**: job passes on a rerun → `ci_runs.status = resolved` → flaky-resolved comment posted on the run; no human action. Reduce retry count or force persistent failure to observe `flaky_retries_exhausted` → escalation comment + `escalated` status.

**Check**: `echo "SELECT status FROM ci_runs WHERE repo='o/n';" | psql $DATABASE_URL` → `resolved`.

### Scenario B — Lint/format real bug auto-fixed (P1, user story 3 — MVP fix path)

1. **Given**: a commit with an unfixable-adjacent-but-fixable lint/format failure (e.g., unformatted file) pushed on a **non-critical** branch.
2. **When**: webhook arrives → classifier `real_bug` (no flaky/infra signal), confidence ≥ 0.7, < 5 files, non-critical branch → guardrail matches `lint/format`.
3. **Then**: lintfixer runs formatter in the worktree, verifies (lint exits 0), commits to `ci-fix/<run-id>`, pushes, posts fix comment.
4. **Expected outcome**: comment with root cause + branch + diff summary + verification on the CI run; branch exists on origin; **no PR opened, nothing merged**.

**Check**: `git ls-remote origin 'ci-fix/*'` shows the branch.

### Scenario C — Real bug, no pattern match → escalate (P1, user story 4)

1. **Given**: a commit with a genuine logic bug (no lint/snapshot/import/timeout signature) on a non-critical branch.
2. **When**: classifier → `real_bug`, confidence ≥ 0.7.
3. **Then**: guardrail finds no allowlist match → escalation writer posts comment.
4. **Expected outcome**: escalation comment with `reason: no_pattern_match`, root cause summary, suggested next step; `escalations` row + `ci_runs.status = escalated`; **no fix attempted**.

### Scenario D — Guardrail hard cases (P1, escalation triggers)

| Case | Setup | Expected |
|---|---|---|
| Low confidence | Failure with conflicting signals (infra-like error on no-infra job) → confidence < 0.7 | Escalate `low_confidence`, no fix |
| Multi-file | Widespread failure touching ≥ 5 files | Escalate `multi_file` |
| Critical branch | Same lint failure but on `main` | Escalate `critical_branch` |
| Infra | Rate-limit / disk-full / docker-pull / expired-creds error (MVP: stub) | Escalate `infra` immediately, no retry, no fix |

All four: verify `escalations` row exists, `ci_runs.status = escalated`, comment posted with `reason` shown.

### Scenario E — Pipelines respect budgets (constraints)

1. **Time**: inject a slow job; pipeline must stop and escalate with partial evidence at the 10-minute budget.
2. **Models**: track LLM calls per pipeline; must never exceed 3 (counter logged in SOR); exhaustion → escalate `budget_exhausted`.

### Scenario F — Auditability (P2, user story 5)

1. Process scenarios A–D; run `npm run sor:verify` (Fleet's SOR verifier).
2. **Expected outcome**: verification passes — hash chain intact; every `classifications`/`fix_attempts`/`escalations` insert has a corresponding SOR event; tampering with any earlier record is detected.

### Scenario G — Duplicate webhook & secrets hygiene

1. Send the same webhook twice → second gets `409`, processed once (dedupe by `external_run_id` + `repo` + `job_id`).
2. Send with no/bad `X-Webhook-Secret` → `401`; enable secret scanning on the repo → zero secret material in commits, logs, comments.

## Expected deliverables after validation

- All tables populated per outcome (see [data-model.md](data-model.md)).
- Comments on CI runs match the formats in [contracts/ci-comment.md](contracts/ci-comment.md).
- SOR chain verifies clean (`npm run sor:verify`).
- MVP loop demonstrated end-to-end: **webhook → worktree → classifier (flaky/real_bug, infra stubbed) → retry runner → lint/format-only fix → escalation comment** — per the constitution's "done" definition.