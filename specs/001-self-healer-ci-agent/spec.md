# Feature Specification: Self-Healer CI Agent

**Feature Branch**: `001-self-healer-ci-agent`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "Build the Self-Healer CI Agent — a system that watches for CI failures, classifies them (flaky / real bug / infra), retries flaky runs, auto-fixes allowlisted patterns on a branch with exactly one attempt, escalates everything else with a root-cause comment on the failing CI run, and logs every decision in an auditable trail."

## User Scenarios & Testing *(mandatory)*

<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - CI failure is caught and put on the right path (Priority: P1)

When a CI job fails in a watched repository, the agent picks up the failure automatically, retrieves the failing job's logs and artifacts, and classifies the failure as flaky, a real bug, or an infrastructure problem — with evidence and a confidence score recorded for every decision.

**Why this priority**: This is the entry point of the entire product. Without reliable intake and classification, nothing downstream (retry, fix, or escalate) can work. It also delivers immediate value: developers get a prompt, evidence-backed verdict on every failure instead of digging through logs themselves.

**Independent Test**: Push a commit that makes a test fail with a clear stack trace, wait for the agent to process the failed CI run, and confirm the run is classified as a real bug with visible evidence and confidence. Pushing a known-intermittent test should instead be classified as flaky, and a failure caused by an expired credential or rate limit should be classified as infra.

**Acceptance Scenarios**:

1. **Given** a watched repository has a CI run that just failed, **When** the agent receives the failure notification, **Then** it retrieves the failing job's logs and artifacts within the pipeline time budget.
2. **Given** a failure with error patterns matching known flaky signals (previously passed on the same commit, timing/race, connection reset), **When** the classifier runs, **Then** the failure is classified as `flaky` with the matching evidence logged.
3. **Given** a failure with error patterns matching known infra signals (rate limit, disk full, Docker pull failure, expired credentials), **When** the classifier runs, **Then** the failure is classified as `infra`.
4. **Given** a failure matching neither flaky nor infra patterns, **When** the classifier runs, **Then** the failure is classified as `real_bug`.
5. **Given** any classification, **When** it is recorded, **Then** the category, confidence score, evidence used, and classifier version are all persisted to the audit trail.

---

### User Story 2 - Flaky failures heal themselves, no human needed (Priority: P1)

When a failure is classified as flaky, the agent reruns the failing job automatically up to three times. If a rerun passes, the failure is resolved with zero human action; if it still fails after three reruns, the agent escalates with evidence.

**Why this priority**: Intermittent test failures are the most common CI noise. Automating the retry removes the bulk of false alarms, and the escalation fallback guarantees a flaky run is never silently abandoned.

**Independent Test**: Simulate a test that fails on the first run and passes on a rerun, and confirm the agent marks the failure resolved without any human involvement. Then simulate a test that fails on all four runs (initial + three reruns) and confirm an escalation is produced.

**Acceptance Scenarios**:

1. **Given** a failure classified as `flaky`, **When** the retry runner executes, **Then** the failing job is rerun automatically, up to a maximum of three reruns.
2. **Given** a rerun that passes, **When** the retry completes, **Then** the failure is marked resolved and a comment is posted on the CI run confirming recovery.
3. **Given** a flaky failure that still fails after three reruns, **When** the retry budget is exhausted, **Then** the failure escalates with the rerun evidence attached.
4. **Given** a flaky failure, **When** the pipeline runs, **Then** no manual intervention is required for resolution.

---

### User Story 3 - Small safe bugs get one auto-fix, proposed for human review (Priority: P1)

When a failure is classified as a real bug with confidence at or above the required threshold, and the failure matches one of the fixable-pattern allowlist entries (outdated snapshot/golden file, obvious single-line import/type error, timeout set too low, or lint/formatting failure), the agent applies exactly one fix, verifies it against the affected tests, and pushes the change to a branch named for the repository plus a `ci-fix` marker. The agent comments on the CI run with the root cause, branch name, diff summary, and test results. It never opens a pull request and never merges.

**Why this priority**: This is the "healer" part of the product — the loop that turns a failing CI run into a verified fix waiting for a human click. It proves the value proposition end-to-end while the human-review gate keeps changes safe.

**Independent Test**: Push a commit with a lint/formatting failure, and confirm the agent produces a single-commit fix branch, verifies the affected tests pass, and posts a comment on the failed CI run describing the root cause and the branch. Confirm no pull request is opened.

**Acceptance Scenarios**:

1. **Given** a failure classified as `real_bug` with confidence ≥ 0.7, **When** the fix scope guardrail evaluates it, **Then** an auto-fix is attempted only if the failure matches an allowlisted pattern (outdated snapshot, single-line import/type error, low timeout, or lint/format).
2. **Given** an auto-fix attempt, **When** the fix loop runs, **Then** exactly one fix attempt is made per failure — never a second attempt if verification fails.
3. **Given** a fix that verifies successfully against the affected tests, **When** delivery happens, **Then** the change is pushed to a `ci-fix`-style branch for the repository and a comment is posted on the CI run with root cause, branch, diff summary, and test results.
4. **Given** any auto-fix outcome, **When** the pipeline finishes, **Then** no pull request is opened and no code is merged automatically.

---

### User Story 4 - Everything else escalates with a clear write-up (Priority: P1)

When a failure cannot be safely auto-fixed — classification confidence below the threshold, a fix attempt already failed, the failure touches five or more files, the failure is on a critical branch (`main`, `release/*`, `v*`), budgets are exhausted, or no allowlist pattern matches — the agent escalates. The escalation is a comment on the failing CI run with the root cause, the evidence gathered, and a suggested next step.

**Why this priority**: Escalation is the safety net that makes auto-fixing acceptable. Guaranteeing that every non-fixable failure lands as a clear, actionable comment is what keeps the whole system trustworthy.

**Independent Test**: Push a failure that touches many files (or a failure on `main`), and confirm the agent posts an escalation comment containing a root cause summary and a suggested next step, with no fix attempted.

**Acceptance Scenarios**:

1. **Given** a failure classified as `real_bug` with confidence below 0.7, **When** the pipeline runs, **Then** it escalates without attempting a fix.
2. **Given** a failure that already had a failed fix attempt, **When** the pipeline runs, **Then** it escalates with the previous attempt's evidence.
3. **Given** a failure involving five or more files, **When** the pipeline runs, **Then** it escalates without attempting a fix.
4. **Given** a failure on a critical branch (`main`, `release/*`, `v*`), **When** the pipeline runs, **Then** it escalates without attempting a fix.
5. **Given** a failure with no allowlist pattern match, **When** the pipeline runs, **Then** it escalates with the classification evidence.
6. **Given** a pipeline whose model-call or time budget is exhausted, **When** the budget limit is hit, **Then** the pipeline stops and escalates with the partial evidence gathered so far.

---

### User Story 5 - Operators can audit every decision the agent makes (Priority: P2)

Every decision the agent makes — classification, retry, fix attempt, and escalation — is recorded with its evidence and confidence in a tamper-evident audit trail. An operator can review the full history of what the agent saw, decided, and did for any CI run.

**Why this priority**: Auditability is what separates the agent from a black box. It enables trust, debugging, and later evaluation of classification quality. It is P2 because the value compounds once the decision paths exist.

**Independent Test**: Process a failure end-to-end and confirm the audit trail contains a complete, ordered record of every decision with its evidence, and that tampering with an earlier record is detectable.

**Acceptance Scenarios**:

1. **Given** any processed failure, **When** the pipeline completes, **Then** every decision (classification, retries, fix attempt, escalation) is present in the audit trail with its evidence and confidence.
2. **Given** a chain of audit records, **When** a record is modified, **Then** tampering is detectable via the hash-chain structure.
3. **Given** the audit trail, **When** an operator reviews a CI run, **Then** they can reconstruct what the agent saw and why it decided what it did.

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- What happens when the infrastructure is unreachable (network down, database unavailable)? The pipeline should fail the run gracefully or escalate, never hang past the time budget.
- What happens when the same CI failure notification arrives twice (duplicate webhook)? A single worker with a FIFO queue should process the failure once and deduplicate repeat notifications for the same run.
- What happens when a failure involves a job whose logs are unavailable or expired? The classifier should still produce a best-effort classification from available evidence and record what was missing.
- What happens when the fix branch already exists from a previous run (reusable `ci-fix`-style branch)? The new fix should replace/update the branch without creating duplicates.
- What happens when a flaky rerun resolves the run but new failures appear on the same run? Each distinct failing job is handled as its own failure under the same run, subject to the same budget rules.
- What happens when the repository or commit cannot be checked out? The pipeline escalates with the checkout failure evidence.
- What happens when secrets or required configuration are missing at startup? The agent refuses to start or escalates loudly — never guesses credentials.
- What happens when a fix verification has no affected test to run (e.g., lint-only change)? Verification runs the closest applicable check (linter/formatter) and reports that in the comment.

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: System MUST accept CI failure notifications from GitHub Actions for configured repositories via a generic webhook listener that does not hard-code a single CI vendor.
- **FR-002**: System MUST retrieve the failing job's logs and artifacts for the notified run within the pipeline time budget.
- **FR-003**: System MUST classify every failure as `flaky`, `real_bug`, or `infra` using rule-augmented signals (flaky: previously passed on same commit, known flaky history, timing/race patterns; infra: rate limit, disk full, Docker pull failure, expired credentials; real bug: everything else).
- **FR-004**: System MUST record category, confidence score, evidence, and classifier version for every classification in the audit trail.
- **FR-005**: System MUST proceed to the fix path only when classification confidence is ≥ 0.7.
- **FR-006**: System MUST rerun a `flaky` failure up to three times and mark it resolved if a rerun passes.
- **FR-007**: System MUST escalate a `flaky` failure if it still fails after three reruns.
- **FR-008**: System MUST escalate `infra` failures immediately with the infra evidence.
- **FR-009**: System MUST only auto-fix real-bug failures that match the fixable-pattern allowlist: outdated snapshot/golden file mismatch, single-line import/type fix, test timeout set too low, or lint/formatting failure.
- **FR-010**: System MUST make at most ONE auto-fix attempt per failure; verification failure leads to escalation, never a second attempt.
- **FR-011**: System MUST verify an auto-fix by running the affected tests (plus a subset of the suite) before proposing it.
- **FR-012**: System MUST deliver fixes by pushing to a reusable `ci-fix`-style branch per repository and commenting on the CI run with root cause, branch name, diff summary, and test results.
- **FR-013**: System MUST NOT open pull requests and MUST NOT merge changes automatically.
- **FR-014**: System MUST escalate (comment on the CI run with root cause and suggested next step) when any of the following holds: confidence < 0.7, a fix attempt already failed, failure involves 5+ files, failure is on `main`/`release/*`/`v*`, budgets are exhausted, or no allowlist pattern matches.
- **FR-015**: System MUST process one failure at a time via a single worker with a FIFO queue; no parallel failure processing.
- **FR-016**: System MUST complete the full pipeline for a failure within a 10-minute budget; on timeout, stop and escalate with partial evidence.
- **FR-017**: System MUST make at most THREE LLM model calls per failure pipeline; on exhaustion, escalate with available evidence.
- **FR-018**: System MUST append every decision (classification, retry, fix attempt, escalation) to a tamper-evident hash-chain audit log with its evidence.
- **FR-019**: System MUST source all secrets (tokens, webhook secrets, API keys) from environment variables only, never from code, config files, logs, comments, or audit records.

### Key Entities *(include if feature involves data)*

- **CI Run**: A single CI execution for a repository/commit/job; carries status, log URL, and artifact URL. Relates to classifications, fix attempts, and escalations.
- **Classification**: The verdict for a CI run failure (`flaky`, `real_bug`, `infra`) with a confidence score, the evidence that drove the decision, and the classifier version.
- **Fix Attempt**: A single auto-fix action for a failure; carries the matched allowlist pattern, the diff produced, the verification result, and the retry/count constraints. At most one per failure.
- **Escalation**: A human-facing handoff for a failure; carries the reason, a human-readable root-cause summary, the evidence, and a suggested next step.

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: `flaky` failures classified with confidence ≥ 0.7 resolve automatically within 10 minutes of the failure notification, with zero manual action.
- **SC-002**: No more than one auto-fix attempt is ever made per failure (100% compliance with the hard cap).
- **SC-003**: 100% of failures that cannot be auto-fixed (low confidence, 5+ files, critical branch, no pattern match, budgets exhausted) produce an escalation comment with a root-cause summary and a suggested next step.
- **SC-004**: 100% of processed failures leave a complete audit-trail record whose tamper-evidence detects any modification to earlier records.
- **SC-005**: 100% of pipelines finish within 10 minutes of webhook receipt; anything longer ends in an escalation with partial evidence.
- **SC-006**: Zero secret material appears in any comment, log, or audit record (0 incident tolerance).

## Assumptions

- The agent runs as a single self-hosted instance that processes one failure at a time (single worker, FIFO queue).
- GitHub Actions is the CI platform covered by v1 acceptance testing; the webhook adapter stays generic so other CI systems (CircleCI, GitLab CI, etc.) can be added later without rework.
- The Fleet LLM fallback chain (Gemini → OpenRouter → Ollama) and tamper-evident audit infrastructure are reused as-is; only the CI-specific pieces are built new.
- The agent has read access to repository contents and CI run logs/artifacts, and push access to create the `ci-fix`-style branch. Human review and merge happen outside the agent.
- A human reviewer always approves any fix before it reaches a critical branch; the agent never merges on its own.
- The 10-minute pipeline and 3-model-call budgets are hard limits set at launch and configurable only through governance-approved amendments.
- v1 fixes are limited to the four allowlisted patterns; additional patterns are added one at a time, each with its own validation and tests.