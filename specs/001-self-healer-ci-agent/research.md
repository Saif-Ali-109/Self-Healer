# Research: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Plan**: [plan.md](plan.md)

Phase 0 output — resolves every unknown from the plan's Technical Context with decisions, rationale, and alternatives considered.

## 1. Dependency strategy: how Self-Healer reuses Fleet

- **Decision**: Self-Healer is a standalone TypeScript repo whose `src/` imports Fleet modules from the local `fleet/` clone via a path alias (dev-time dependency). The `fleet/` clone is gitignored and never pushed to GitHub; only Self-Healer's own source + `specs/` + `.specify/` are committed.
- **Rationale**: The constitution's Development Workflow says "reuse from Fleet, do not rebuild" — orchestrator, worker runtime, provider registry, tools, SOR hash-chain, dashboard/SSE/TUI, and MCP pattern. Importing from the sibling clone makes every reuse literal (single copy of the code) and keeps the Self-Healer GitHub repo clean (only net-new + docs).
- **Alternatives considered**: (a) vendoring Fleet's source into Self-Healer — rejected: duplicates the codebase, breaks the dependency relationship, and bloats the repo; (b) npm-packaging Fleet as a library — rejected: Fleet is a private, unbuilt project with no publish step; (c) making Self-Healer an in-place overlay inside the fleet clone — rejected: the fleet clone is upstream-owned and we must not diverge it.

## 2. Webhook listener hosting

- **Decision**: Host the CI webhook endpoint on Fleet's existing dashboard HTTP server, using the `WebhookHandler` type already defined in `src/dashboard/api.ts` (with `WEBHOOK_MAX_BYTES = 256 KB` payload cap).
- **Rationale**: Fleet's dashboard server is a zero-runtime-dependency Node http server already running in the daemon; there is a ready-made webhook dispatch shape. No new HTTP framework or process needed.
- **Alternatives considered**: (a) standalone Express/Fastify listener — rejected: adds a dependency and a second server; (b) separate process — rejected: complicates lifecycle, secrets, and single-worker guarantee.

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

- **Decision**: `allowlist.ts` implements the four patterns from the spec/constitution (outdated snapshot/golden file, single-line import/type fix, low timeout, lint/format), but MVP ships **only the lint/format pattern** wired end-to-end. The other three are added one at a time, each with its own verification, per constitution.
- **Rationale**: Constitution Development Workflow explicitly scopes MVP to lint/format-only; each additional pattern needs its own validator + tests. Keep this tight.
- **Alternatives considered**: shipping all four patterns in MVP — rejected: contradicts constitution's phased MVP definition and increases unvalidated-fix risk.

## 7. Retry runner (flaky path)

- **Decision**: Retry runner reruns the failed job via the `gh api` wrapper (Fleet's `gh.ts` pattern) using the platform's rerun endpoint, max 3 reruns. Still failing → escalate with rerun evidence.
- **Rationale**: Constitution Delivery: up to 3 reruns for flaky; using the platform's own rerun API is the only correct way to re-execute a job (locally re-running tests would not reproduce the CI environment).
- **Alternatives considered**: local re-run of the test command in a worktree — rejected: doesn't exercise the real CI environment; misleading results.

## 8. Delivery and escalation channels

- **Decision**: Fix delivery pushes to a reusable `ci-fix`-style branch per repository (`ci-fix/<run-id>`), then comments on the CI run via `gh api` with root cause, branch name, diff summary, test results. Escalations comment on the CI run with root cause + suggested next step. No PRs, no merges.
- **Rationale**: Constitution principle V. Comments on the run keep context with the failure; branch-per-repo reusability avoids branch explosion.
- **Alternatives considered**: opening PRs/auto-merge — rejected (constitution NON-NEGOTIABLE); posting to issues — rejected: separates context from the failing run.

## 9. Storage and SOR integration

- **Decision**: New migrations `017_ci_runs`, `018_classifications`, `019_fix_attempts`, `020_escalations` extend Fleet's Postgres schema; every row's decisions are additionally mirrored through Fleet's SOR `ingest` so the tamper-evident hash-chain covers CI events just like issue events.
- **Rationale**: Constitution Operating Constraints — Postgres persistence and SOR hash-chain, reusing Fleet's schema pattern (see `migrations/001`/`004`).
- **Alternatives considered**: separate audit store — rejected: must share the same chain as Fleet's tables (constitution: "chained into the same SOR hash-chain").

## 10. Cache/Prior knowledge for flaky detection

- **Decision**: Flaky signal "passed on a previous run of same commit/branch" reads `ci_runs` history (status of prior runs for the same commit) plus a `flaky_history` lookup on the `classifications` table. No separate cache service.
- **Rationale**: The Postgres tables already carry the needed history; an extra cache is unneeded complexity.
- **Alternatives considered**: Redis/TTL cache — rejected: overkill at single-worker scale; history lives in Postgres.

## 11. Opportunity: evaluation dataset

- **Decision**: Every classification log (category, evidence, confidence) becomes a labeled dataset for later classifier-quality evaluation (per project spec §5: "this gives you an eval set later").
- **Rationale**: Free by-product of mandatory audit logging; no extra work now, big debugging value later.
- **Alternatives considered**: none — zero-cost.

## Consolidated decisions

| # | Unknown/choice | Decision |
|---|---|---|
| 1 | Fleet reuse | Import from local `fleet/` clone via path alias (dev-only, gitignored) |
| 2 | Webhook hosting | Fleet dashboard server + existing `WebhookHandler` |
| 3 | CI adapter | Canonical normalized event; GitHub Actions adapter first |
| 4 | Classifier | Rule-first signals; LLM only for root-cause summary |
| 5 | Confidence | Rule-strength-based; ≥ 0.7 to fix, < 0.7 escalate |
| 6 | Fix guardrail | Allowlist of 4; MVP ships lint/format only |
| 7 | Flaky retry | Platform job rerun via `gh api`, max 3 |
| 8 | Delivery | `ci-fix/<run-id>` branch + CI-run comment; no PR/merge |
| 9 | Storage | 4 new Postgres tables + SOR chain reuse |
| 10 | Flaky history | Postgres-based (ci_runs/classifications), no cache |
| 11 | Eval set | Auto-collected from classification logs |