# Implementation Plan: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-self-healer-ci-agent/spec.md`

## Summary

When a CI job fails in a watched repository, the agent classifies the failure (`flaky` / `real_bug` / `infra`) using rule-augmented signals, then either retries flaky runs (up to 3), auto-fixes allowlisted bugs on a `ci-fix/<run-id>` branch (verified in a worktree, surfaced as a fix-only PR for human approval, never merged), or escalates everything else with a root-cause comment. Every decision is recorded in a tamper-evident SOR hash chain stored in `node:sqlite`.

Self-Healer is a **standalone Node.js daemon** — no Fleet clone, no PostgreSQL server. Git worktrees are created via direct `git worktree` shell calls. The SOR chain is an append-only table inside SQLite.

## Technical Context

**Language/Version**: TypeScript 5.7 (strict, ESM, `"type": "module"`), Node.js ≥ 22.

**Primary Dependencies**: `node:sqlite` (built into Node 22+, zero extra dep), `tsx`, `vitest` v3, `@biomejs/biome` v2, `typescript`. No `pg`, no Fleet runtime dependency.

**Storage**: `node:sqlite` — single-file SQLite database with migrations 001–022. SOR hash chain is an append-only audit-events table with per-row hash chaining.

**Testing**: Vitest v3 (unit + integration), Biome for lint/format. DB-gated integration suites auto-skip when `DATABASE_URL` is absent (uses SQLite fallback path or skips cleanly).

**Target Platform**: Linux server, self-hosted single instance, long-running daemon process.

**Project Type**: standalone daemon / web service (CI failure agent).

**Performance Goals**: One failure processed at a time (single worker, FIFO). End-to-end pipeline must complete within 10 minutes per failure. Retries for flaky runs bounded at 3.

**Constraints**: ≤ 1 auto-fix attempt per failure; ≤ 3 LLM calls per failure; classification confidence ≥ 0.7 required to proceed to fix; fix scope = full repo but human-review-gated; all secrets from environment variables; worktrees isolated + cleaned up; no PR merges, only fix-only PRs.

**Scale/Scope**: Standalone loop — webhook/poll → worktree → classifier (flaky/real_bug, infra stubbed) → retry runner → allowlist fix → verify → fix-only PR → human merge. Two active patterns (`lint/format`, `import/type`) + two stubs (`snapshot`, `timeout`).

## Constitution Check

| Constitution Rule | Status | How the plan satisfies it |
|---|---|---|
| I. CI-Agnostic Webhook Handling | ✅ PASS | Generic webhook listener + GitHub Actions adapter; daemon also polls GitHub Actions for failed runs on watched repos. |
| II. Rule-Augmented Classification (NON-NEGOTIABLE) | ✅ PASS | Classifier is rule-first (regex signals), LLM only enriches; every classification logged to SOR with evidence and confidence. |
| III. Fix-Scope Guardrail (NON-NEGOTIABLE) | ✅ PASS | Auto-fix only for allowlist (`lint/format`, `import/type`); MVP ships both; anything else escalates; hard cap of ONE attempt per failure. |
| IV. Tamper-Evident Auditability | ✅ PASS | Every decision routed to SOR append-only hash chain in SQLite; `sor:verify` validates; tamper simulation detected and recovers. |
| V. Human-Approved Delivery | ✅ PASS | Delivery = fix-only PR on `ci-fix/<run-id>` + CI-run comment; no merge, ever. |
| LLC: 3-call cap | ✅ PASS | Budget counter enforced; exhaustion → escalate with evidence. |
| LLC: node:sqlite, no external DB | ✅ PASS | Single-file SQLite with migrations 001–022; SOR chain implemented directly. |
| LLC: Secrets via env only | ✅ PASS | `.env.example` documents all vars; `.env` gitignored; nothing secret logged. |
| LLC: Single worker FIFO | ✅ PASS | Webhook handler enqueues; one worker processes at a time; duplicate webhook events deduped by run id. |
| LLC: 10-min budget | ✅ PASS | Pipeline timer; timeout → stop + escalate with partial evidence. |
| LLC: Worktree isolation | ✅ PASS | Direct `git worktree add/remove` shell calls; cwd-locked tool access; cleaned up after pipeline. |
| Delivery: flaky → ≤3 retries | ✅ PASS | Retry runner reruns via GitHub Actions API, max 3; still failing → escalate. |
| Delivery: confidence ≥ 0.7 | ✅ PASS | Below threshold → escalate, never fix. |
| Dev: standalone, no Fleet | ✅ PASS | All logic implemented directly; Fleet clone not required. |
| Repo hygiene | ✅ PASS | Only self-healer source + `specs/` + `.specify/` committed; `.env`, `node_modules`, `.runs` gitignored. |

## Project Structure

```text
src/
  webhook/          HMAC-verified webhook server + GitHub Actions adapter
  pipeline/
    queue.ts        FIFO worker queue
    orchestrator.ts classification → fix/retry/escalation dispatch
    classifier/     rule-first flaky / infra / real_bug
    retry/          flaky rerun budget
    fixscope/       allowlist + lintfixer + importfixer (pure detection + shell drivers)
    escalation/     reasons → suggested next step
  audit/            run reconstruction for auditing
  db/               SQLite pool-less access + migration runner (migrations 001–022)
tests/              unit + integration suites
specs/001-self-healer-ci-agent/
  spec.md           this feature spec
  plan.md           this file
  data-model.md     SQLite schema
  quickstart.md     validation guide
  contracts/        pattern contracts (fix-attempt.md, etc.)
  tasks.md          task checklist
  research.md       phase 0 research
```

## Migration Notes

Migrations 001–016 are bundled with Fleet but applied to the standalone SQLite database. Migrations 017–022 are Self-Healer's own tables:
- `017_ci_runs.sql` — `ci_runs` table
- `018_classifications.sql` — `classifications` table
- `019_fix_attempts.sql` — `fix_attempts` table
- `020_escalations.sql` — `escalations` table
- `021_ci_runs_skipped_status.sql` — `ci_runs.skipped_status`
- `022_fix_pr_url.sql` — `fix_attempts.fix_pr_url`
- `audit_events` — append-only SOR hash-chain table (created with 017)

SQLite types: `TEXT` for UUIDs and JSON, `INTEGER` for counts/timestamps, `REAL` for confidence scores. No `JSONB` or `gen_random_uuid()` — SQLite uses `LOWER(HEX(RANDOM()))` or application-side UUIDs.
