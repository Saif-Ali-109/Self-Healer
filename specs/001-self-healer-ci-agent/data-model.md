# Data Model: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

Extends the existing Fleet PostgreSQL schema (same database, same SOR hash-chain). Four new tables: `ci_runs`, `classifications`, `fix_attempts`, `escalations` (migrations `017`–`020`). Naming and conventions mirror Fleet's existing migrations (`UUID PK` via `gen_random_uuid()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`).

## Entity: CI Run

Represents one CI execution that failed and was picked up by the agent. The intake record for a failure.

| Field | Type | Constraints / Notes |
|---|---|---|
| `run_id` | UUID | PK, `DEFAULT gen_random_uuid()` |
| `external_run_id` | TEXT | NOT NULL — CI platform's run identifier (e.g., GitHub Actions run id) |
| `repo` | TEXT | NOT NULL — `owner/name` slug |
| `commit` | TEXT | NOT NULL — full commit SHA at failure |
| `branch` | TEXT | NOT NULL — branch ref the failure occurred on |
| `job_id` | TEXT | NOT NULL — failing job identifier |
| `job_name` | TEXT | failing job name (for comments) |
| `status` | TEXT | NOT NULL — `CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved'))` |
| `log_url` | TEXT | URL to failing job logs |
| `artifact_url` | TEXT | URL to failure artifacts (nullable) |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| `completed_at` | TIMESTAMPTZ | nullable |

**Relationships**: `1 — N classifications` (a run can be re-evaluated), `1 — 0..1 fix_attempts` (hard cap of one), `1 — 0..1 escalations`. A run where a flaky classification resolves has no fix attempt and no escalation.

**Validation rules** (from FR-001/FR-002): `external_run_id` + `repo` + `job_id` must be unique per run (dedupe of duplicate webhooks); `status` transitions only forward (below); required to have `log_url` for any classification to proceed.

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

The verdict for a CI run failure. Every run gets exactly one *decision* classification (FR-003); reruns by the retry runner produce additional trace-within-pipeline records only if reclassified.

| Field | Type | Constraints / Notes |
|---|---|---|
| `classification_id` | UUID | PK |
| `run_id` | UUID | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE |
| `category` | TEXT | NOT NULL — `CHECK (category IN ('flaky','real_bug','infra'))` |
| `confidence` | NUMERIC(3,2) | NOT NULL — 0.00–1.00 |
| `evidence` | JSONB | NOT NULL — the signals/patterns that drove the decision (logs read, pattern matched) |
| `classifier_version` | TEXT | NOT NULL — deterministic signal-set version, e.g., `signals-v1` |
| `model` | TEXT | nullable — LLM used only to enrich root-cause summary (subject to 3-call cap) |
| `summary` | TEXT | human-readable root-cause summary (LLM-enriched for real bugs) |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |

**Validation rules**: confidence must be a number in `[0,1]` with 2 decimal places; `evidence` must be non-empty (constitution principle II — no silent decisions); category must be one of the three.

**Relationship**: `N — 1 ci_runs`.

## Entity: Fix Attempt

The single auto-fix action for a failure (hard cap: **at most one per `run_id`**, per FR-010 and constitution principle III).

| Field | Type | Constraints / Notes |
|---|---|---|
| `attempt_id` | UUID | PK |
| `run_id` | UUID | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE, UNIQUE |
| `pattern_matched` | TEXT | NOT NULL — which allowlist pattern, e.g., `lint/format` (MVP: only this one) |
| `diff` | TEXT | NOT NULL — the exact diff produced |
| `branch` | TEXT | NOT NULL — the `ci-fix/<run-id>` branch pushed |
| `verification_result` | TEXT | NOT NULL — `CHECK (verification_result IN ('passed','failed'))` |
| `test_summary` | TEXT | what tests/checks were run for verification |
| `comment_url` | TEXT | URL of the CI-run comment posted |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |

**Validation rules**: UNIQUE on `run_id` enforces the "no second attempt" rule at the database level; `diff` must be non-empty; `verification_result` must be set before the pipeline finishes.

**Relationship**: `1 — 1 ci_runs` (0..1 per run).

## Entity: Escalation

A human-facing handoff when the agent cannot or must not fix.

| Field | Type | Constraints / Notes |
|---|---|---|
| `escalation_id` | UUID | PK |
| `run_id` | UUID | NOT NULL, FK → `ci_runs(run_id)` ON DELETE CASCADE |
| `reason` | TEXT | NOT NULL — `CHECK (reason IN ('low_confidence','fix_failed','multi_file','critical_branch','budget_exhausted','no_pattern_match','infra','flaky_retries_exhausted','checkout_failed'))` |
| `summary` | TEXT | NOT NULL — human-readable root-cause summary |
| `suggested_next_step` | TEXT | NOT NULL — what a human should do next |
| `comment_url` | TEXT | URL of the escalation comment on the CI run |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() |

**Validation rules**: `reason` must be one of the enumerated values (each maps to one of the 6 constitution escalation triggers + infra + checkout failure); `summary` and `suggested_next_step` must be non-empty; a run may have **at most one** escalation (an escalated run is terminal for that pipeline) — enforced by unique index on `run_id`.

**Relationship**: `1 — 1 ci_runs` (0..1 per run).

## SOR integration

- Every insert into `classifications`, `fix_attempts`, and `escalations` is mirrored through Fleet's SOR `ingest` with event type `phase` (or a `ci_*` event extension), so the tamper-evident hash-chain covers CI decisions alongside Fleet's existing issue-run decisions (constitution principle IV).
- `ci_runs` row lifecycle (status changes) is itself chained as SOR events so state transitions are provable.

## Indexes

```sql
CREATE UNIQUE INDEX uq_ci_runs_extrn ON ci_runs (external_run_id, repo, job_id);
CREATE INDEX idx_classifications_run ON classifications (run_id);
CREATE INDEX idx_classifications_category ON classifications (category, created_at);
CREATE UNIQUE INDEX uq_fix_attempts_run ON fix_attempts (run_id);
CREATE UNIQUE INDEX uq_escalations_run ON escalations (run_id);
CREATE INDEX idx_ci_runs_commit ON ci_runs (repo, commit);
CREATE INDEX idx_ci_runs_branch ON ci_runs (branch);
```