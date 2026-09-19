# Feature Specification: Self-Healer CI Agent

**Feature Branch**: `001-self-healer-ci-agent`

**Created**: 2026-09-13

**Status**: Draft (updated for standalone architecture)

**Input**: User description: "Build the Self-Healer CI Agent — a system that watches for CI failures, classifies them (flaky / real bug / infra), retries flaky runs, auto-fixes allowlisted bugs on a branch with exactly one attempt, escalates everything else with a root-cause comment on the failing CI run, and logs every decision in an auditable trail."

## Overview

Self-Healer is a **standalone Node.js daemon** (no Fleet dependency, no PostgreSQL server). It uses `node:sqlite` (built into Node 22+) for persistence and direct `git worktree` shell calls for isolated fixes. Every decision is chained into a tamper-evident SOR hash chain stored in SQLite.

## User Scenarios & Testing

### User Story 1 - CI failure is caught and put on the right path (Priority: P1)

When a CI job fails in a watched repository, the agent picks up the failure automatically, retrieves the failing job's logs and artifacts, and classifies the failure as flaky, a real bug, or an infrastructure problem — with evidence and a confidence score recorded for every decision.

**Independent Test**: Push a commit that makes a test fail with a clear stack trace, wait for the agent to process the failed CI run, and confirm the run is classified as a real bug with visible evidence and confidence. Pushing a known-intermittent test should instead be classified as flaky, and a failure caused by an expired credential or rate limit should be classified as infra.

**Acceptance Scenarios**:

1. Given a watched repository has a CI run that just failed, when the agent receives the failure notification, then it retrieves the failing job's logs and artifacts within the pipeline time budget.
2. Given a failure with error patterns matching known flaky signals (previously passed on the same commit/branch, timing/race, connection reset), when the classifier runs, then the failure is classified as `flaky` with the matching evidence logged.
3. Given a failure with error patterns matching known infra signals (rate limit, disk full, Docker pull failure, expired credentials), when the classifier runs, then the failure is classified as `infra`.
4. Given a failure matching neither flaky nor infra patterns, when the classifier runs, then the failure is classified as `real_bug`.
5. Given any classification, when it is recorded, then the category, confidence score, evidence used, and classifier version are all persisted to the audit trail.

---

### User Story 2 - Flaky failures heal themselves, no human needed (Priority: P1)

When a failure is classified as flaky, the agent reruns the failing job automatically up to three times. If a rerun passes, the failure is resolved with zero human action; if it still fails after three reruns, the agent escalates with evidence.

**Acceptance Scenarios**:

1. Given a failure classified as `flaky`, when the retry runner executes, then the failing job is rerun automatically, up to a maximum of three reruns.
2. Given a rerun that passes, when the retry completes, then the failure is marked resolved and a comment is posted on the CI run confirming recovery.
3. Given a flaky failure that still fails after three reruns, when the retry budget is exhausted, then the failure escalates with the rerun evidence attached.

---

### User Story 3 - Small safe bugs get one auto-fix, proposed for human review (Priority: P1)

When a failure is classified as a real bug with confidence at or above the required threshold, and the failure matches one of the fixable-pattern allowlist entries, the agent applies exactly one fix, verifies it against the affected tests in a worktree, and pushes the change to a `ci-fix/<run-id>` branch as a **fix-only pull request for human approval**. The agent comments on the CI run with the root cause, branch name, diff summary, and test results. It never merges.

**Fixable patterns (allowlist)**:

| Pattern | Detection | Verification |
|---------|-----------|--------------|
| `lint/format` | biome / eslint / prettier diagnostics | `npx @biomejs/biome check .` |
| `import/type` | `ReferenceError: X is not defined` | `node src/main.mjs` (repo convention) |
| `snapshot` | — (stub, post-MVP) | — |
| `timeout` | — (stub, post-MVP) | — |

**Acceptance Scenarios**:

1. Given a failure classified as `real_bug` with confidence ≥ 0.7, when the fix scope guardrail evaluates it, then an auto-fix is attempted only if the failure matches an allowlisted pattern.
2. Given an auto-fix attempt, when the fix loop runs, then exactly one fix attempt is made per failure — never a second attempt if verification fails.
3. Given a fix that verifies successfully, when delivery happens, then the change is pushed to a `ci-fix/<run-id>` branch as a fix-only PR, and a comment is posted on the CI run with root cause, branch, diff summary, and test results.
4. Given any auto-fix outcome, when the pipeline finishes, then no code is merged automatically — a human reviews and merges the PR.

---

### User Story 4 - Everything else escalates with a clear write-up (Priority: P1)

When a failure cannot be safely auto-fixed — classification confidence below the threshold, a fix attempt already failed, the failure touches five or more files, the failure is on a critical branch (`main`, `release/*`, `v*`), budgets are exhausted, or no allowlist pattern matches — the agent escalates. The escalation is a comment on the failing CI run with the root cause, the evidence gathered, and a suggested next step.

**Acceptance Scenarios**:

1. Given a failure classified as `real_bug` with confidence below 0.7, when the pipeline runs, then it escalates without attempting a fix.
2. Given a failure that already had a failed fix attempt, when the pipeline runs, then it escalates with the previous attempt's evidence.
3. Given a failure involving five or more files, when the pipeline runs, then it escalates without attempting a fix.
4. Given a failure on a critical branch (`main`, `release/*`, `v*`), when the pipeline runs, then it escalates without attempting a fix.
5. Given a failure with no allowlist pattern match, when the pipeline runs, then it escalates with the classification evidence.
6. Given a pipeline whose model-call or time budget is exhausted, when the budget limit is hit, then the pipeline stops and escalates with partial evidence gathered so far.

---

### User Story 5 - Operators can audit every decision the agent makes (Priority: P2)

Every decision the agent makes — classification, retry, fix attempt, and escalation — is recorded with its evidence and confidence in a tamper-evident audit trail stored in SQLite. An operator can review the full history of what the agent saw, decided, and did for any CI run, and verify the chain has not been tampered with.

**Acceptance Scenarios**:

1. Given any processed failure, when the pipeline completes, then every decision (classification, retries, fix attempt, escalation) is present in the audit trail with its evidence and confidence.
2. Given a chain of audit records, when a record is modified, then tampering is detectable via the hash-chain structure (`npm run sor:verify`).
3. Given the audit trail, when an operator reviews a CI run, then they can reconstruct what the agent saw and why it decided what it did (`npm run audit:run -- <run-id>`).

---

### User Story 6 - Developers can install and enable the agent on any repo (Priority: P2)

A developer installs the standalone package, configures one `.env`, opts a repository in with `self-healer-notify.yml`, and starts the daemon. The daemon polls GitHub Actions for failed jobs on watched repos and processes them automatically.

**Acceptance Scenarios**:

1. Given a developer runs `self-healer init`, when they configure `.env`, then the SQLite database and `.env` template are created.
2. Given a developer runs `self-healer enable --repo owner/repo`, when the command completes, then `self-healer-notify.yml` is written to the repo and the repo is registered as watched.
3. Given the daemon is running and a watched repo has a failing CI job, when the job fails, then the agent processes it automatically (no CI config changes required in the repo).

---

## Requirements

### Functional Requirements

- **FR-001**: System MUST accept CI failure notifications from GitHub Actions for configured repositories via a generic webhook listener that does not hard-code a single CI vendor. The daemon also polls GitHub Actions for failed runs on watched repos.
- **FR-002**: System MUST retrieve the failing job's logs and artifacts for the notified run within the pipeline time budget.
- **FR-003**: System MUST classify every failure as `flaky`, `real_bug`, or `infra` using rule-augmented signals.
- **FR-004**: System MUST record category, confidence score, evidence, and classifier version for every classification in the SOR audit trail (SQLite).
- **FR-005**: System MUST proceed to the fix path only when classification confidence is ≥ 0.7.
- **FR-006**: System MUST rerun a `flaky` failure up to three times and mark it resolved if a rerun passes.
- **FR-007**: System MUST escalate a `flaky` failure if it still fails after three reruns.
- **FR-008**: System MUST escalate `infra` failures immediately with the infra evidence.
- **FR-009**: System MUST only auto-fix real-bug failures that match the fixable-pattern allowlist: `lint/format`, `import/type`, and post-MVP stubs (`snapshot`, `timeout`).
- **FR-010**: System MUST make at most ONE auto-fix attempt per failure; verification failure leads to escalation, never a second attempt.
- **FR-011**: System MUST verify an auto-fix by running the pattern's `verifyCommand` in the worktree before proposing it.
- **FR-012**: System MUST deliver fixes by pushing to a `ci-fix/<run-id>` branch and surfacing a **fix-only PR** for human review; a comment is posted on the CI run with root cause, branch, diff summary, and test results.
- **FR-013**: System MUST NOT merge changes automatically — a human always reviews and merges the fix PR.
- **FR-014**: System MUST escalate when any of the following holds: confidence < 0.7, a fix attempt already failed, failure involves 5+ files, failure is on `main`/`release/*`/`v*`, budgets are exhausted, or no allowlist pattern matches.
- **FR-015**: System MUST process one failure at a time via a single worker with a FIFO queue; no parallel failure processing.
- **FR-016**: System MUST complete the full pipeline for a failure within a 10-minute budget; on timeout, stop and escalate with partial evidence.
- **FR-017**: System MUST make at most THREE LLM model calls per failure pipeline; on exhaustion, escalate with available evidence. LLM enrichment is optional; the classifier is rule-first.
- **FR-018**: System MUST append every decision to a tamper-evident hash-chain audit log stored in SQLite (`npm run sor:verify` proves tamper-freeness).
- **FR-019**: System MUST source all secrets from environment variables only, never from code, config files, logs, comments, or audit records.
- **FR-020**: System MUST ignore webhook events from its own `ci-fix/*` branches (prevent loops).
- **FR-021**: System MUST only process repositories that contain `self-healer-notify.yml` (opt-in gating).

### Key Entities

- **CI Run**: A single CI execution for a repository/commit/job; carries status, log URL, and artifact URL.
- **Classification**: The verdict for a CI run failure (`flaky`, `real_bug`, `infra`) with a confidence score, evidence, and classifier version.
- **Fix Attempt**: A single auto-fix action; carries the matched pattern, diff, branch, verification result, PR URL. At most one per failure.
- **Escalation**: A human-facing handoff; carries the reason, root-cause summary, and suggested next step.
- **Audit Event**: An append-only SOR record with a hash chain binding it to the previous record.

---

## Packaging Roadmap

Self-Healer ships as a standalone package (`self-healer-ci-agent` or Docker image). No Fleet clone, no PostgreSQL server, no extra runtime dependencies.

**Target installation:**
```bash
npm i -g self-healer-ci-agent
self-healer init        # creates .env + SQLite database
self-healer enable --repo org/repo   # writes self-healer-notify.yml
self-healer start       # daemon on CI_WEBHOOK_PORT (default :3457)
```

**Out of scope (future):** GitHub App form, multi-worker scaling, LLM enrichment, dashboard UI, standalone demo-repo re-run (re-run after packaging completes).

---

## Edge Cases

- What happens when the infrastructure is unreachable (network down)? The pipeline should fail the run gracefully or escalate, never hang past the time budget.
- What happens when the same CI failure notification arrives twice (duplicate webhook)? A single worker with a FIFO queue should process the failure once and dedupe repeat notifications for the same run.
- What happens when a failure involves a job whose logs are unavailable or expired? The classifier should still produce a best-effort classification from available evidence and record what was missing.
- What happens when a fix branch already exists from a previous run? The new fix should replace/update the branch without creating duplicates.
- What happens when the repository or commit cannot be checked out? The pipeline escalates with the checkout failure evidence.
- What happens when secrets or required configuration are missing at startup? The agent refuses to start or escalates loudly — never guesses credentials.
- What happens when a fix verification has no affected test to run (e.g., lint-only change)? Verification runs the closest applicable check (linter/formatter) and reports that in the comment.

## Assumptions

- The agent runs as a single self-hosted instance that processes one failure at a time (single worker, FIFO queue).
- GitHub Actions is the CI platform covered by v1 acceptance testing; the webhook adapter stays generic so other CI systems can be added later.
- The agent uses `node:sqlite` (built into Node 22+) and direct `git worktree` shell calls; no external database server or Fleet clone is required.
- The agent has read access to repository contents and CI run logs/artifacts, and push access to create the `ci-fix`-style branch. Human review and merge happen outside the agent.
- A human reviewer always approves any fix before it reaches the critical branch; the agent never pushes to protected branches.
- The 10-minute pipeline and 3-model-call budgets are hard limits set at launch.
- Fix patterns are added one at a time, each with its own validation step and tests.
- The daemon polls GitHub Actions for failed runs on watched repos (in addition to receiving webhooks), so the developer's CI workflow needs no changes.
- `self-healer-notify.yml` is the opt-in mechanism; only repos carrying this file are processed.

## Success Criteria

- **SC-001**: `flaky` failures classified with confidence ≥ 0.7 resolve automatically within 10 minutes of the failure notification, with zero manual action.
- **SC-002**: No more than one auto-fix attempt is ever made per failure (100% compliance with the hard cap).
- **SC-003**: 100% of failures that cannot be auto-fixed (low confidence, 5+ files, critical branch, no pattern match, budgets exhausted) produce an escalation comment with a root-cause summary and a suggested next step.
- **SC-004**: 100% of processed failures leave a complete audit-trail record whose tamper-evidence detects any modification to earlier records (`sor:verify` passes).
- **SC-005**: 100% of pipelines finish within 10 minutes of webhook receipt; anything longer ends in an escalation with partial evidence.
- **SC-006**: Zero secret material appears in any comment, log, or audit record (0 incident tolerance).
- **SC-007**: The standalone package installs and runs with no external database server or Fleet clone (`npm i -g`, `self-healer init`, `self-healer start`).
