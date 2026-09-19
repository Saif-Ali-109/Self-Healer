# Research: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

Phase 0 output — resolves every unknown from the plan's Technical Context with decisions, rationale, and alternatives considered. Updated for standalone architecture (no Fleet, no PostgreSQL).

## 1. Dependency strategy: standalone

- **Decision**: Self-Healer is a self-contained TypeScript repo with no external runtime dependencies beyond Node 22+ built-ins (`node:sqlite`, `node:child_process`, `node:fs`, `node:http`, `node:path`, `node:url`). No Fleet clone.
- **Rationale**: The constitution's Development Workflow (v1.3.0) says build standalone — orchestrator, worker runtime, provider registry, tools, SOR hash-chain, and git worktree calls are all implemented directly. This removes the Fleet clone as a prerequisite and makes the package self-installable.
- **Alternatives considered**: (a) keep Fleet clone as dev dependency — rejected: adds a prerequisite that blocks standalone distribution; (b) vendor Fleet's source — rejected: Fleet is upstream-owned and not versioned for this use; (c) npm-packaging Fleet — rejected: Fleet is a private, unbuilt project.

## 2. Webhook listener hosting

- **Decision**: Standalone `node:http` server on `CI_WEBHOOK_PORT` (default `3457`). The `handleCiWebhook` function is exported as a pure `(headers, rawBody) → { status, body }` function, so it can be mounted on another server if desired.
- **Rationale**: A standalone server keeps Self-Healer independent — no dashboard server dependency, no Fleet process to manage. The pure-function export keeps the door open for mounting on Fleet's dashboard later if a user wants that.
- **Alternatives considered**: (a) Fleet's dashboard server — rejected: adds Fleet as a hard prerequisite; (b) Express/Fastify — rejected: adds a dependency; standalone `node:http` is sufficient.

## 3. CI payload adapter (GitHub Actions first)

- **Decision**: A `normalize.ts` canonical CI-failure event shape (`repo`, `commit`, `run_id`, `job_id`, `status`, `log_url`, `artifact_url`, `branch`) is the adapter contract. `adapters/github.ts` maps GitHub Actions `workflow_job`/`check_run` webhook JSON into it. Other CI systems (CircleCI, GitLab) become additional adapters later, satisfying constitution principle I (CI-agnostic).
- **Rationale**: The classifier, retry runner, and escalation writer all consume the canonical shape, so CI-agnosticism is structural rather than cosmetic.
- **Alternatives considered**: (a) one-off GitHub-specific struct everywhere — rejected: violates constitution principle I; (b) schema-less passthrough — rejected: untyped and untestable.

## 4. Classifier design (rule-first, LLM-light)

- **Decision**: The classifier is a deterministic, rule-augmented role. `signals.ts` encodes flaky signals (same test passed on a previous run of the same commit/branch, known flaky history, timing/race patterns: timeout, connection reset, non-deterministic order) and infra signals (rate limit, disk full, Docker pull failure, expired credentials). Real bug = everything else. LLM is used only to enrich a real-bug classification with a human-readable root-cause summary (subject to the 3-call cap).
- **Rationale**: Constitution principle II is NON-NEGOTIABLE — rule-augmented, not pure LLM judgment. Deterministic signals give reproducible evidence and confidence; the LLM adds readability without decision authority.
- **Alternatives considered**: Pure LLM classification — rejected (violates principle II, non-deterministic, no reproducible evidence).

## 5. Confidence scoring and threshold

- **Decision**: Confidence is derived from rule match strength (e.g., exact signal match = high, multiple independent signals = higher; conflicting signals lower it). Threshold: ≥ 0.7 to proceed to fix; below → escalate. Confidence + evidence are stored per classification.
- **Rationale**: Constitution Delivery requires ≥ 0.7; a simple, explainable scoring function makes the threshold testable and auditable.
- **Alternatives considered**: LLM-provided confidence — rejected: conflicts with rule-augmented principle and reproducibility.

## 6. Fix-scope guardrail and MVP pattern

- **Decision**: `allowlist.ts` implements the four patterns from the spec/constitution (outdated snapshot/golden file, single-line import/type fix, low timeout, lint/format). MVP ships `lint/format` and `import/type` wired end-to-end. Additional patterns are added one at a time, each with its own verification, per constitution.
- **Rationale**: Constitution Development Workflow explicitly scopes patterns to one-at-a-time; each needs its own validator + tests. Keep this tight.
- **Alternatives considered**: shipping all patterns in MVP — rejected: contradicts constitution's phased approach and increases unvalidated-fix risk.

## 7. Retry runner (flaky path)

- **Decision**: Retry runner reruns the failed job via `gh api` using the GitHub Actions rerun endpoint, max 3 reruns. Still failing → escalate with rerun evidence.
- **Rationale**: Constitution Delivery: up to 3 reruns for flaky; using the platform's own rerun API is the only correct way to re-execute a job (locally re-running tests would not reproduce the CI environment).
- **Alternatives considered**: local re-run of the test command in a worktree — rejected: doesn't exercise the real CI environment; misleading results.

## 8. Delivery and escalation channels

- **Decision**: Fix delivery pushes to a reusable `ci-fix`-style branch per repository (`ci-fix/<run-id>`), opens a **fix-only PR** for human review, and comments on the CI run via `gh api` with root cause, branch name, diff summary, test results, and PR link. Escalations comment on the CI run with root cause + suggested next step. The robot never merges.
- **Rationale**: Constitution principle V (v1.2.0). Fix-only PRs put the change in front of a human without giving the agent merge power. Comments on the run keep context with the failure.
- **Alternatives considered**: opening PRs/auto-merge — rejected (constitution NON-NEGOTIABLE); posting to issues — rejected: separates context from the failing run.

## 9. Storage and SOR integration

- **Decision**: `node:sqlite` (built into Node 22+, zero extra dependencies) stores `ci_runs`, `classifications`, `fix_attempts`, `escalations`, and an append-only `audit_events` table forming the SOR hash chain. Migrations 001–022 applied to the SQLite database. SOR hash chain implemented directly in SQLite — no external database server and no Fleet dependency.
- **Rationale**: Constitution Operating Constraints — a single-file database is sufficient for the scale and removes the PostgreSQL prerequisite. The append-only hash chain provides tamper-evidence without Postgres triggers.
- **Alternatives considered**: (a) PostgreSQL — rejected: requires a running server; adds a prerequisite; (b) JSON files — rejected: no ACID, poor concurrency, hard to query; (c) Redis — rejected: overkill at single-worker scale; not a durable audit store.

## 10. Cache/Prior knowledge for flaky detection

- **Decision**: Flaky signal "passed on a previous run of same commit/branch" reads `ci_runs` history (status of prior runs for the same commit) from SQLite. No separate cache service.
- **Rationale**: The SQLite tables already carry the needed history; an extra cache is unneeded complexity.
- **Alternatives considered**: Redis/TTL cache — rejected: overkill at single-worker scale; history lives in SQLite.

## 11. Opportunity: evaluation dataset

- **Decision**: Every classification log (category, evidence, confidence) becomes a labeled dataset for later classifier-quality evaluation.
- **Rationale**: Free by-product of mandatory audit logging; no extra work now, big debugging value later.
- **Alternatives considered**: none — zero-cost.

## Consolidated decisions

| # | Unknown/choice | Decision |
|---|---|---|
| 1 | Dependency strategy | Standalone — no Fleet clone; `node:sqlite` + direct `git worktree` calls |
| 2 | Webhook hosting | Standalone `node:http` server on `CI_WEBHOOK_PORT`; `handleCiWebhook` is a pure exported function |
| 3 | CI adapter | Canonical normalized event; GitHub Actions adapter first |
| 4 | Classifier | Rule-first signals; LLM only for root-cause summary |
| 5 | Confidence | Rule-strength-based; ≥ 0.7 to fix, < 0.7 escalate |
| 6 | Fix guardrail | Allowlist (`lint/format`, `import/type` + stubs); MVP ships both active patterns |
| 7 | Flaky retry | Platform job rerun via `gh api`, max 3 |
| 8 | Delivery | `ci-fix/<run-id>` branch + fix-only PR + CI-run comment; no merge |
| 9 | Storage | `node:sqlite`; SOR hash chain as append-only table in SQLite |
| 10 | Flaky history | SQLite-based (`ci_runs`/`classifications`), no cache |
| 11 | Eval set | Auto-collected from classification logs |
