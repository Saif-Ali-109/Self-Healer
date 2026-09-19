# Data Model: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

Self-contained `node:sqlite` database (built into Node 22+, zero extra dependencies). Eight tables: `ci_runs`, `classifications`, `fix_attempts`, `escalations`, `audit_events` (SOR hash chain), `watched_repos`, plus `ci_runs_skipped_status` and `fix_pr_url` columns. Migrations `001`–`023` (021 is a documented no-op; 023 adds `watched_repos`).

SQLite types used: `TEXT` (UUIDs, JSON, strings), `INTEGER` (counts, timestamps), `REAL` (confidence scores). No `JSONB` or `gen_random_uuid()` — application-side UUIDs via `crypto.randomUUID()`.

## Entity: CI Run

Represents one CI execution that failed and was picked up by the agent. The intake record for a failure.

| Field | Type | Constraints / Notes |
|---|---|---|
| `run_id` | TEXT | PK — `crypto.randomUUID()` |
| `external_run_id` | TEXT | NOT NULL — CI platform's run identifier (e.g., GitHub Actions run id) |
| `repo` | TEXT | NOT NULL — `owner/name` slug |
| `commit` | TEXT | NOT NULL — full commit SHA at failure |
| `branch` | TEXT | NOT NULL — branch ref the failure occurred on |
| `job_id` | TEXT | NOT NULL — failing job identifier |
| `job_name` | TEXT | failing job name (for comments) |
| `status` | TEXT | NOT NULL — `CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved','skipped'))` |
| `log_url` | TEXT | URL to failing job logs |
| `artifact_url` | TEXT | URL to failure artifacts (nullable) |
| `created_at` | INTEGER | NOT NULL — Unix timestamp |
| `completed_at` | INTEGER | nullable — Unix timestamp |

**Relationships**: `1 — N classifications`, `1 — 0..1 fix_attempts` (hard cap of one), `1 — 0..1 escalations`.

**Validation rules**: `external_run_id` + `repo` + `job_id` must be unique per run (dedupe of duplicate webhooks); `status` transitions only forward; `log_url` required for any classification to proceed.

**State transitions**:

```text
pending → classifying → retrying → resolved        (flaky passes on rerun)
                      │          └→ escalated        (flaky fails after 3 reruns)
                      ├→ escalated                   (infra, confidence < 0.7, 5+ files,
                      │                               critical branch, no pattern match)
                      └→ fixing → resolved           (lint/format fix verified)
                              └→ escalated            (fix verification failed)
```

## Entity: Classification

The verdict for a CI run failure. Every run gets exactly one classification.

| Field | Type | Constraints / Notes |
|---|---|---|
| `classification_id` | TEXT | PK |
| `run_id` | TEXT | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE |
| `category` | TEXT | NOT NULL — `CHECK (category IN ('flaky','real_bug','infra'))` |
| `confidence` | REAL | NOT NULL — 0.00–1.00 |
| `evidence` | TEXT | NOT NULL — JSON string of signals/patterns that drove the decision |
| `classifier_version` | TEXT | NOT NULL — deterministic signal-set version, e.g., `signals-v1` |
| `model` | TEXT | nullable — LLM used only to enrich root-cause summary (subject to 3-call cap) |
| `summary` | TEXT | human-readable root-cause summary (LLM-enriched for real bugs) |
| `created_at` | INTEGER | NOT NULL — Unix timestamp |

**Validation rules**: confidence must be a number in `[0,1]`; `evidence` must be non-empty; category must be one of the three.

## Entity: Fix Attempt

The single auto-fix action for a failure (hard cap: at most one per `run_id`).

| Field | Type | Constraints / Notes |
|---|---|---|
| `attempt_id` | TEXT | PK |
| `run_id` | TEXT | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE, UNIQUE |
| `pattern_matched` | TEXT | NOT NULL — which allowlist pattern, e.g., `lint/format`, `import/type` |
| `diff` | TEXT | NOT NULL — the exact diff produced |
| `branch` | TEXT | NOT NULL — the `ci-fix/<run-id>` branch pushed |
| `verification_result` | TEXT | NOT NULL — `CHECK (verification_result IN ('passed','failed'))` |
| `test_summary` | TEXT | what tests/checks were run for verification |
| `fix_pr_url` | TEXT | URL of the fix-only PR opened |
| `comment_url` | TEXT | URL of the CI-run comment posted |
| `created_at` | INTEGER | NOT NULL — Unix timestamp |

**Validation rules**: UNIQUE on `run_id` enforces the "no second attempt" rule at the database level; `diff` must be non-empty; `verification_result` must be set before the pipeline finishes.

## Entity: Escalation

A human-facing handoff for a failure (0..1 per run).

| Field | Type | Constraints / Notes |
|---|---|---|
| `escalation_id` | TEXT | PK |
| `run_id` | TEXT | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE, UNIQUE |
| `reason` | TEXT | NOT NULL — escalation reason code (e.g., `flaky_retries_exhausted`, `no_pattern_match`, `low_confidence`, `critical_branch`, `too_many_files`, `budget_exhausted`, `fix_failed`, `infra`) |
| `summary` | TEXT | human-readable root-cause summary |
| `suggested_next_step` | TEXT | what a human should do next |
| `evidence` | TEXT | JSON string of evidence gathered |
| `created_at` | INTEGER | NOT NULL — Unix timestamp |

## Entity: Watched Repo

Repos opted in via `self-healer enable --repo owner/repo` (US6). Enabling writes
`self-healer-notify.yml` to the repo on a `self-healer/enable` branch and opens a
PR; the row is recorded at enable time so `status` can list watched repos.

| Field | Type | Constraints / Notes |
|---|---|---|
| `repo` | TEXT | PK — `owner/repo` |
| `added_at` | INTEGER | NOT NULL — Unix timestamp |
| `workflow_branch` | TEXT | NOT NULL — branch carrying the reporter workflow |
| `workflow_pr` | TEXT | PR that adds `self-healer-notify.yml` (human must merge) |

## Entity: Audit Event (SOR hash chain)

Append-only tamper-evident record of every decision.

| Field | Type | Constraints / Notes |
|---|---|---|
| `event_id` | TEXT | PK |
| `run_id` | TEXT | NOT NULL — links to the CI run |
| `event_type` | TEXT | NOT NULL — `classification`, `retry`, `fix_attempt`, `escalation`, `status_change` |
| `payload` | TEXT | NOT NULL — JSON string of the event data |
| `prev_hash` | TEXT | NOT NULL — hash of the previous audit event (empty string for the first event) |
| `event_hash` | TEXT | NOT NULL — `HMAC-SHA256(prev_hash || payload || key)` |
| `created_at` | INTEGER | NOT NULL — Unix timestamp |

**Tamper detection**: `sor:verify` replays the chain, recomputing each `event_hash` from `prev_hash || payload || key`. Any mismatch indicates tampering.

## Entity: ci_runs_skipped_status

Tracks repos/branches skipped by the `ci-fix/*` guard or `self-healer-notify.yml` gating.

| Field | Type | Constraints / Notes |
|---|---|---|
| `skip_id` | TEXT | PK |
| `repo` | TEXT | NOT NULL |
| `external_run_id` | TEXT | NOT NULL |
| `reason` | TEXT | NOT NULL — e.g., `ci_fix_branch`, `not_authorized` |
| `created_at` | INTEGER | NOT NULL |

## Migrating from PostgreSQL

When migrating from the Fleet/PostgreSQL architecture:
1. Replace `pg` pool with `node:sqlite` connection
2. Convert `UUID PK DEFAULT gen_random_uuid()` → `TEXT PK` with application-side UUIDs
3. Convert `JSONB` columns → `TEXT` (store JSON strings)
4. Convert `TIMESTAMPTZ DEFAULT now()` → `INTEGER` Unix timestamps
5. Convert `NUMERIC(3,2)` → `REAL`
6. Convert `gen_random_uuid()` → `LOWER(HEX(RANDOM()))` or application-side `crypto.randomUUID()`
7. Remove Postgres-specific sequences, triggers, and constraints; rely on SQLite constraints + application logic
