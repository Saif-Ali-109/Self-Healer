<!--
Sync Impact Report
- Version change: 2.0.0 → 3.0.0 (MAJOR: principle V redefined — a verified fix MAY be surfaced as a best-effort **fix-only pull request** from `ci-fix/<run-id>` to the failing branch for human review; PR open failure falls back to branch + comment; the agent still NEVER merges and NEVER touches protected branches) — explicitly approved by the project owner. Record with `npm run sor:amend:v3`.
- Version change: 1.3.0 → 2.0.0 (MAJOR: III allowlist + single attempt removed; V fix-PR removed; LLM cap replaced) — approved by the project owner via the upgrade spec (docs/UPGRADE.md). Record with `npm run sor:amend:v2`.
- Modified principles: III (Fix-Scope Guardrail → AI fixes for any CI failure, verified by the FULL suite), IV (audit now includes the agent's reasoning trace), V (push to ci-fix branch + CI comment ONLY; never a PR, never a merge)
- Added: bounded re-fix loop; per-repo learning notes; provider selection (Gemini/OpenRouter/Ollama) global + per repo
- Version change: 1.1.0 → 1.2.0 (MINOR: principle V expanded — a verified auto-fix MAY now be surfaced as a fix-only pull request for human review; the agent still never merges)
- Modified principles: V (Human-Approved Delivery — expanded)
- Added sections: none
- Removed sections: none
- Follow-up TODOs: none
- Version change: 1.2.0 → 1.3.0 (MAJOR: architecture changed — dropped Fleet clone and PostgreSQL entirely; standalone Node.js daemon with built-in node:sqlite and direct git worktree calls)
- Modified principles: IV (Tamper-Evident Auditability — SOR now implemented directly in SQLite, not Fleet's Postgres chain)
- Added sections: Packaging Roadmap (Standalone distribution)
- Removed sections: Fleet dependency references
- Follow-up TODOs: none
-->

# Self-Healer CI Agent Constitution

## Core Principles

### I. CI-Agnostic Webhook Handling
The agent MUST ingest failures from any CI system through a generic webhook listener that adapts to platform-specific payloads (GitHub Actions, CircleCI, etc.) rather than hard-coding support for a single vendor. On failure, it MUST pull the failing job logs and artifacts, then open a worktree at the failing commit. Findings MUST be posted as comments on the CI run via the platform's API.

### II. Rule-Augmented Classification (NON-NEGOTIABLE)
Every failure MUST be classified as `flaky`, `real_bug`, or `infra`, using rule-augmented signals rather than pure LLM judgment. Flaky signals: same test passed on a previous run of the same commit/branch, known flaky-test history, or timing/race patterns (timeout, connection reset, non-deterministic order). Infra signals: known infra patterns (rate limit, disk full, docker pull failure, expired credentials). Real bug: everything else. Each classification MUST record its evidence and confidence in the SOR hash-chain. No silent decisions are permitted.

### III. Verified, Bounded AI Fixes (NON-NEGOTIABLE)
The agent MAY attempt to fix ANY bug causing CI to fail (logic, types, tests, dependencies), using an LLM tool-calling loop confined to an isolated worktree. No fix is ever pushed unless the FULL test suite (plus any configured checks) passes in that worktree — regardless of bug type — and the diff passes the guardrails: no deleted/skipped tests, no CI-config edits, no secrets, fewer than the configured file cap, self-reported confidence ≥ 0.7. If CI still fails on the pushed `ci-fix/*` branch the same pipeline runs again, up to a configurable cap (default THREE re-fix cycles) per branch; beyond that the agent MUST escalate. Unverifiable (no test command) or unsure ⇒ escalate; an unvalidated fix is worse than no fix.

### IV. Tamper-Evident Auditability
Every decision (classification, retry, fix attempt, escalation) MUST be appended to the SOR hash-chain (stored in SQLite) with the evidence used (logs read, pattern matched, confidence, model, run IDs). The agent's behavior MUST remain fully auditable end-to-end.

### V. Human-Approved Delivery
The agent MUST NEVER merge anything. A VERIFIED fix is pushed (never forced) to the `ci-fix/<run-id>` branch and reported in a CI run comment with root cause, reasoning, diff summary, test results and reviewer warnings (dependency changes, edited tests). The fix MAY additionally be surfaced as a **fix-only pull request** from `ci-fix/<run-id>` to the failing branch for normal GitHub review. PR opening is BEST-EFFORT: if it fails (network, cross-fork commit, permissions, head equals base) delivery falls back to branch + comment and never blocks the fix. Escalations are CI run comments with root-cause summary and suggested next step. Protected branches (`main`, `release/*`, `v*`) are never touched. A human always reviews and merges before any change reaches the critical path.

## Operating Constraints

- **LLM access**: Only Gemini, OpenRouter and Ollama; selectable globally and per repo (self-healer.config.json). The classifier stays rule-first; the agent runs after it. Per-run budgets (model calls, tool calls, time, re-fix cycles) are configurable with safe defaults; exhaustion escalates with available evidence.
- **Memory**: The agent's reasoning trace is chained in the SOR log; durable per-repo learning notes live in `repo_notes` and are treated as untrusted hints.
- **Sandboxing**: Repo commands run without a shell, from an allowlist, with a scrubbed environment, timeouts and worktree-confined files; operators SHOULD add an OS-level wrapper for untrusted repos.
- **Persistence**: `node:sqlite` (built into Node 22+, zero extra dependencies). Four tables — `ci_runs`, `classifications`, `fix_attempts`, `escalations` — plus an append-only audit-events table forming the SOR hash chain. All records chained within the SQLite database; no external database server required.
- **Secrets**: All secrets (GitHub tokens, webhook secrets, API keys) MUST come from environment variables. Never committed, never logged. `.env.example` documents every required variable; the real `.env` MUST be gitignored.
- **Concurrency**: Single worker with a FIFO queue. One CI failure is processed at a time; all others wait.
- **Time budget**: Total pipeline budget of a configurable time budget (default TWENTY minutes) per failure, from webhook receipt to resolution (fix, retry, or escalation). On timeout, stop and escalate with partial evidence.
- **Fix scope**: May touch any file in the repository (full-repo scope), but every change is human-review-gated.
- **Worktrees**: Each role runs in an isolated child-process worker with cwd-locked tool access to its own worktree. Worktrees are created and cleaned up via direct `git worktree` shell calls.

## Delivery & Escalation

- **Flaky classification**: Retry Runner reruns the job up to THREE times. Still failing → escalate.
- **Infra classification**: Escalate immediately as an infra issue; no fix attempted.
- **Real bug classification**: Hand off to the AI agent (III).
- **Confidence**: Classification confidence MUST be ≥ 0.7 to proceed with auto-fix. Below 0.7, default to escalate.
- **Escalation triggers (MUST escalate, MUST NOT fix, when ANY holds)**:
  1. The agent's self-reported confidence < 0.7
  2. The re-fix cap for the branch was reached
  3. The fix would touch the configured file cap or more
  4. Failure is on a critical branch: `main` or any `release/*` / `v*` tag
  5. LLM or time budget exhausted
  6. No test command / no usable LLM provider / a guardrail violation
- **Fix verification**: The full suite (plus `verifyCommands`) must pass in the worktree before any push. A failing gate is fed back to the agent within its budget; never pushed.
- **Fix delivery**: A successful fix is pushed to the `ci-fix/<run-id>` branch with a CI comment, and MAY be surfaced as a best-effort fix-only PR to the failing branch for human review; the agent never merges.

## Development Workflow

- Build standalone: orchestrator pattern, child-process worker runtime, provider registry, tools (bash/read/write/edit/grep/glob), and SOR hash-chain are implemented directly. No Fleet dependency.
- Net new work is limited to: CI webhook listener, classifier role, fix-scope guardrail, retry runner, and escalation writer.
- MVP is "done" when the loop webhook → worktree → classifier (flaky vs. real_bug, infra stubbed) → retry runner → lint/format-only fix → escalation comment works end-to-end, with tests covering each piece.
- Additional fixable patterns are added one at a time, each with its own validation step and tests.
- **Packaging**: Self-Healer ships as a standalone package (`self-healer-ci-agent`). No Fleet clone, no PostgreSQL server. See §Packaging Roadmap below.
- **Repository hygiene**: commit only project spec files and source. Do not commit local config, secrets, or tooling directories. Tooling state under `.specify` is shared deliberately.
- **Parallel task execution**: Build tasks MAY be executed by subagents in parallel, but ONLY where tasks do not conflict. No two subagents MUST ever edit the same file at the same time; a file is owned by one subagent at a moment. Tasks touching the same file MUST be serialized or merged by the orchestrator, and conflicts MUST be resolved before committing.

## Governance

- The constitution governs HOW the system behaves; the project spec (`specs/001-self-healer-ci-agent/spec.md`) governs WHAT is built. On building questions the spec wins; on behavior questions the constitution wins.
- Amendments MUST be documented, explicitly approved by a human, and follow semantic versioning: MAJOR for backward-incompatible principle removals or redefinitions, MINOR for new principles or materially expanded guidance, PATCH for clarifications and wording refinements.
- Every constitution change MUST be recorded in the SOR log (what changed, when, why).
- All pull requests and reviews MUST verify compliance with this constitution.

## Packaging Roadmap (Standalone distribution)

Self-Healer ships as a standalone package (`self-healer-ci-agent` or Docker image). No Fleet clone, no PostgreSQL server, no extra runtime dependencies.

### Target installation

```bash
npm i -g self-healer-ci-agent
self-healer init        # creates .env + SQLite database
self-healer enable --repo org/repo   # writes self-healer-notify.yml
self-healer start       # daemon on CI_WEBHOOK_PORT (default :3457)
```

### What the package includes

- Webhook listener + single FIFO worker daemon
- `node:sqlite` database (built into Node 22+) with migrations 001–024
- Direct `git worktree` calls (no Fleet import)
- SOR append-only hash chain inside SQLite
- All fix patterns (active + stubs)
- CLI: `init`, `start`, `enable`, `status`
- `.env.example` template

### What the package does NOT include

- Fleet clone (removed as a dependency)
- PostgreSQL server (replaced by SQLite)
- Dashboard UI (Fleet provides one if needed, separately)

### Out of scope (future)

- GitHub App form (native webhooks instead of tunnel)
- Multi-worker / horizontal scaling
- LLM enrichment beyond the rule-first classifier
- Standalone demo-repo re-run (re-run after packaging completes)

**Version**: 3.0.0 | **Ratified**: 2026-09-13 | **Last Amended**: 2026-09-21