# Feature Specification: Self-Healer CI Agent

**Feature Branch**: `001-self-healer-ci-agent`

**Created**: 2026-09-13

**Status**: Implemented / as-built v2 — standalone daemon + AI repair agent + per-repo notes memory (updated 2026-09-25)

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

### User Story 3 - Real bugs get an AI-agent auto-fix, proposed for human review (Priority: P1)

When a failure is classified as a real bug with confidence at or above the required threshold (≥ 0.7), the **AI repair agent** (`ai-agent` pattern) diagnoses and fixes it in an isolated worktree at the failing commit, verifies the **full test suite** passes, and pushes the change to a `ci-fix/<run-id>` branch as a **fix-only pull request for human approval**. The agent comments on the CI run with the root cause, branch name, diff summary, and test results. It never merges. Deterministic patterns (`lint/format`, `import/type`) fire first when their detection matches; everything else still routes through the LLM agent.

**Fixable patterns (allowlist)**:

| Pattern | Detection | Verification |
|---------|-----------|--------------|
| `ai-agent` | any `real_bug` (rule-first classification) | full suite green (`npm test` → gate on finish) |
| `lint/format` | biome / eslint / prettier diagnostics | `npx @biomejs/biome check .` |
| `import/type` | `ReferenceError: X is not defined` | `node src/main.mjs` (repo convention) |
| `snapshot` | — (stub) | — |
| `timeout` | — (stub) | — |

**Acceptance Scenarios**:

1. Given a failure classified as `real_bug` with confidence ≥ 0.7, when the fix scope guardrail evaluates it, then the failure is handed to the AI repair agent (deterministic patterns fire first when matched).
2. Given an agent run, when `finish` is called, then the full test suite runs as the gate; gate failures are fed back and the agent keeps working (≤ 3 finish rejections). The database records exactly ONE `fix_attempts` row per CI run (unique `uq_fix_attempts_run`).
3. Given a fix that the gate verifies successfully, when delivery happens, then the change is pushed to a `ci-fix/<run-id>` branch and a fix-only PR is opened; a comment is posted on the CI run with root cause, branch, diff summary, and test results. If the PR can't open, delivery falls back to branch + CI comment.
4. Given any auto-fix outcome, when the pipeline finishes, then no code is merged automatically — a human reviews and merges the PR.
5. Given CI still fails after a fix was pushed, when a new run arrives on that branch, then a **re-fix cycle** runs against the previous attempt (parent_run_id, `fix_cycle`, ≤ `maxFixCycles` = 3), and the notes the earlier fix was built on are penalized.

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
3. Given the daemon is running and a watched repo has a failing CI job, when the job fails, then the agent processes it automatically (the only repo change is the opt-in `self-healer-notify.yml` reporter workflow).

---

### User Story 7 - The agent remembers what it learned about a repo (Priority: P1, shipped)

The agent keeps **persistent per-repo learning notes** (`repo_notes` in SQLite — "notes for himself"). After every `finish`/`give_up` it writes 0–3 durable takeaways (root causes, flaky-tests, how the suite must run, approaches that failed); before every fix run it retrieves the notes most relevant to the failing log/job-name and injects them into the prompt as hints. Humans can also teach it (`self-healer notes add` — highest confidence). Notes reinforce on agreement, decay when a fix built on them fails, and retire when untrusted.

**Acceptance Scenarios**:

1. Given an agent run that finishes, when the pipeline completes, then the agent's 0–3 notes are stored for the repo (`ci_notes_written`), deduplicated against near-identical notes (jaccard ≥ 0.6 merges and reinforces).
2. Given a later run on the same repo, when the task prompt is built, then the top relevant active notes are injected as hints (`ci_notes_read`), length-capped, secret-redacted, and framed as DATA ("verify before trusting").
3. Given a fix built on notes that then fails in a later cycle, when lineage detects it, then the source notes' confidence is decayed (×0.7) and any below 0.2 are retired.
4. Given an operator, when they run `self-healer notes list --repo owner/repo`, then active notes with kind, confidence, and body are shown; `notes add` and `notes retire` work likewise.

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
- **FR-009**: System MUST route `real_bug` failures (confidence ≥ 0.7) to the AI repair agent (`ai-agent`); deterministic patterns `lint/format` and `import/type` fire first when their detection matches. `snapshot` / `timeout` remain stubs.
- **FR-010**: System MUST record at most ONE `fix_attempts` row per CI run (unique `uq_fix_attempts_run`); re-fix cycles across subsequent CI runs on the same branch are bounded by `maxFixCycles` (default 3).
- **FR-011**: System MUST verify a fix before proposing it — the full test suite as the gate for `ai-agent`, the pattern's `verifyCommand` in the worktree for deterministic patterns.
- **FR-012**: System MUST deliver fixes by pushing to a `ci-fix/<run-id>` branch and surfacing a **fix-only PR** for human review (titled `🤖 Self-Healer: auto-fix for CI run #<run-id>`); if the PR cannot open (network, cross-fork, head == base), it MUST fall back to branch + CI comment. A comment is posted on the CI run with root cause, branch, diff summary, and test results.
- **FR-013**: System MUST NOT merge changes automatically — a human always reviews and merges the fix PR.
- **FR-014**: System MUST escalate when any of the following holds: confidence < 0.7, a fix attempt already failed, failure involves 5+ files, failure is on `main`/`release/*`/`v*`, budgets are exhausted, or no allowlist pattern matches.
- **FR-015**: System MUST process one failure at a time via a single worker with a FIFO queue; no parallel failure processing.
- **FR-016**: System MUST complete the full pipeline for a failure within the configured pipeline budget (`pipelineBudgetMs`, default 20 minutes; the lab config widens it to 40 minutes for free-tier request pacing); on timeout, stop and escalate with partial evidence.
- **FR-017**: System MUST bound LLM usage per run via `maxLlmCalls` (default 40) and `maxToolCalls` (default 80); on exhaustion, escalate with available evidence. LLM enrichment is optional and the classifier is rule-first.
- **FR-018**: System MUST append every decision to a tamper-evident hash-chain audit log stored in SQLite (`npm run sor:verify` proves tamper-freeness).
- **FR-019**: System MUST source all secrets from environment variables only, never from code, config files, logs, comments, or audit records.
- **FR-020**: System MUST ignore webhook events from its own `ci-fix/*` branches (prevent loops).
- **FR-021**: System MUST only process repositories that contain `self-healer-notify.yml` (opt-in gating).
- **FR-022**: System MUST persist per-repo learning notes (`repo_notes`); notes are written by the agent (`finish`/`give_up`), the pipeline, and humans; retrieved before each fix run (keyword-scored), injected as length-capped, secret-redacted hints, and reinforced / decayed / retired by outcome.
- **FR-023**: System MUST support exactly four LLM providers for the repair agent — `gemini`, `openrouter`, `ollama`, `groq` — selectable globally and/or per repo in `self-healer.config.json`; the classifier never requires an LLM.

### Key Entities

- **CI Run**: A single CI execution for a repository/commit/job; carries status, log URL, and artifact URL.
- **Classification**: The verdict for a CI run failure (`flaky`, `real_bug`, `infra`) with a confidence score, evidence, and classifier version.
- **Fix Attempt**: A single auto-fix action; carries the matched pattern, diff, branch, verification result, PR URL. At most one per failure.
- **Escalation**: A human-facing handoff; carries the reason, root-cause summary, and suggested next step.
- **Audit Event**: An append-only SOR record with a hash chain binding it to the previous record.
- **Repo Note**: A durable, per-repo learning note (kind, body, tags, files, confidence, source) that survives across runs and is injected into later runs as a hint.

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

**Out of scope (future):** GitHub App form, multi-worker scaling, LLM enrichment beyond rule-first, dashboard UI, standalone demo-repo re-run (re-run after packaging completes).

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
- The 20-minute pipeline budget (default; config-tunable), `maxLlmCalls` (default 40) and `maxToolCalls` (default 80) are the hard limits; the lab config widens the time budget to 40 minutes purely for free-tier request pacing.
- Fix patterns are added one at a time, each with its own validation step and tests.
- The daemon receives GitHub Actions webhooks (and polls failed runs on watched repos where configured); the only repository change required is the opt-in `self-healer-notify.yml` reporter workflow.
- `self-healer-notify.yml` is the opt-in mechanism; only repos carrying this file are processed.

## Success Criteria

- **SC-001**: `flaky` failures classified with confidence ≥ 0.7 resolve automatically within the pipeline budget (default 20 min) of the failure notification, with zero manual action.
- **SC-002**: No more than one auto-fix attempt is ever recorded per CI run (unique `uq_fix_attempts_run`, 100% compliance with the hard cap); any re-fix happens as a fresh run in a bounded cycle (≤ `maxFixCycles`).
- **SC-003**: 100% of failures that cannot be auto-fixed (low confidence, 5+ files, critical branch, no pattern match, budgets exhausted) produce an escalation comment with a root-cause summary and a suggested next step.
- **SC-004**: 100% of processed failures leave a complete audit-trail record whose tamper-evidence detects any modification to earlier records (`sor:verify` passes).
- **SC-005**: 100% of pipelines finish within the configured pipeline budget of webhook receipt; anything longer ends in an escalation with partial evidence.
- **SC-006**: Zero secret material appears in any comment, log, or audit record (0 incident tolerance).
- **SC-007**: The standalone package installs and runs with no external database server or Fleet clone (`npm i -g`, `self-healer init`, `self-healer start`).
- **SC-008**: Per-repo notes persist across runs and measurably influence later runs (retrieved + injected, `ci_notes_read` recorded; reinforcement/decay/retire observable via `self-healer notes list`).

---

## Live Delivery Evidence

Delivered end-to-end against the `Saif-Ali-109/demo-repo` contract repo:

| Deliverable | Evidence |
|---|---|
| `lint/format` fix | formatting error in `src/widget.js` → auto-fix → **PR #33** on `ci-fix/<run-id>` — merged by human |
| `import/type` fix | `ReferenceError: renderWidget is not defined` → added import → verified `node src/main.mjs` (exit 0) → **PR #34** — merged by human |
| flaky escalation (by design) | hardcoded intermittent failure → 3 reruns exhausted → escalate `flaky_retries_exhausted` |
| escalation (by design) | hardcoded unknown error → no pattern match → escalate `no_pattern_match` |
| **First AI-agent delivery** | run `97df1109` → agent fixed `src/calc.js` `multiply` (`a + b` → `a * b`), verified `npm test` in-worktree, pushed `ci-fix/97df1109`, opened **PR #40** (base `demo-real-bugs`), commented on the failing run |

**Timeline of the AI-agent delivery** (webhook → PR): `14:08:56` UTC webhook → classified `real_bug` 0.9 at `14:09:02` → agent loop (7 steps, `groq/gpt-oss-120b`, 2,595 → 3,355 input tokens) `14:09:06–14:10:30` → verified `npm test: passed` → resolved + **PR #40 opened at 14:10:40 — 1 m 44 s total.** The agent's takeaway survives in `repo_notes`: `[root_cause] conf=0.6 src=agent: "multiply incorrectly returned sum instead of product, causing test failure."`
