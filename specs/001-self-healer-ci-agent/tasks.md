---

description: "Task list template for feature implementation"
---

# Tasks: Self-Healer CI Agent

**Input**: Design documents from `/specs/001-self-healer-ci-agent/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Test tasks ARE included — required by the constitution ("with tests covering each piece" for MVP done) and mapped to the validation scenarios in `quickstart.md`.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/`, `migrations/` at repository root (Self-Healer repo)
- Self-Healer is standalone — all logic implemented directly. `node:sqlite` (built-in) for storage, direct `git worktree` shell calls for isolated fixes. No Fleet clone dependency.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [X] T001 Create repo scaffolding per plan.md: `src/webhook/`, `src/pipeline/{classifier,fixscope,retry,escalation}/`, `src/db/`, `src/sor/`, `src/utils/`, `tests/{unit,integration,fixtures}/`, `tests/fixtures/`
- [X] T002 Initialize TypeScript project: `package.json` (`"type": "module"`, engines `node >=22`), `tsconfig.json` (strict ESM, `noEmit`), no path alias needed (standalone)
- [X] T003 [P] Configure lint/format tooling: `biome.json` + `lint`/`format` npm scripts
- [X] T004 [P] Create `.env.example` documenting `GH_TOKEN`, `CI_WEBHOOK_SECRET`, `DATABASE_URL`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`; extend `.gitignore` for `.env` (never committed)
- [X] T005 Add npm scripts to `package.json`: `start`, `typecheck`, `test`, `migrate:up`, `sor:verify`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T006 Create migration `migrations/017_ci_runs.sql` (table + `uq_ci_runs_extrn`, `idx_ci_runs_commit`, `idx_ci_runs_branch`) per data-model.md
- [X] T007 [P] Create migration `migrations/018_classifications.sql` (table + `idx_classifications_run`, `idx_classifications_category`) per data-model.md
- [X] T008 [P] Create migration `migrations/019_fix_attempts.sql` (table + unique `uq_fix_attempts_run` enforcing the one-attempt cap) per data-model.md
- [X] T009 [P] Create migration `migrations/020_escalations.sql` (table + unique `uq_escalations_run`) per data-model.md
- [X] T010 Extend `src/db/migrate.ts` to register and apply migrations 017–020 (order + dependency-safe)
- [X] T011 Implement env/secret loader `src/config.ts` — validate required vars at startup and fail loudly if missing; never log secret values
- [X] T012 Define canonical normalized CI event type + response-code contract in `src/types.ts` per contracts/webhook-ci.md
- [X] T013 Implement shared CI comment client `src/pipeline/comments.ts` — posts to a CI run via the `gh` api wrapper, redacts secret patterns, formats the 3 comment types from contracts/ci-comment.md
- [X] T014 Implement SOR chaining helper `src/sor/ciEvents.ts` — chains `classifications`/`fix_attempts`/`escalations` inserts and `ci_runs` status transitions through the SQLite SOR hash chain
- [X] T015 Implement budget tracker `src/utils/budget.ts` — hard 3-call LLM cap + 10-minute pipeline timer; on exhaustion signal escalation with partial evidence

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 - CI failure is caught and put on the right path (Priority: P1) 🎯

**Goal**: Webhook intake → normalize → classify (`flaky`/`real_bug`/`infra`) with evidence + confidence persisted; dedupe and FIFO single-worker queue.

**Independent Test**: Push a failing commit → webhook accepted (`202`), `ci_runs` row created, classification row with evidence appears; wrong secret → `401`; duplicate payload → `409` (quickstart scenarios A-partial + G).

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T016 [P] [US1] Contract test for webhook endpoint auth + response codes in `tests/integration/webhook_test.ts` using `tests/fixtures/github-workflow-job-fail.json`
- [X] T017 [P] [US1] Unit test classifier signals + confidence scoring in `tests/unit/classifier_test.ts` (flaky/infra/real_bug per contracts/classification.md)

### Implementation for User Story 1

- [X] T018 [P] [US1] Implement normalization `src/webhook/normalize.ts` — validate payload, build canonical event, compute dedupe key (`external_run_id`+`repo`+`job_id`)
- [X] T019 [US1] Implement GitHub Actions adapter `src/webhook/adapters/github.ts` mapping `workflow_job` payload → canonical event (contracts/webhook-ci.md)
- [X] T020 [US1] Implement webhook endpoint `src/webhook/server.ts` — `POST /api/webhook/ci`, HMAC-verify `X-Webhook-Secret`, return `202/400/401/409`. Implemented as a standalone `node:http` server on `CI_WEBHOOK_PORT`; `handleCiWebhook` stays mountable via the `ApiHandlers` interface
- [X] T021 Implement FIFO queue + dedupe `src/pipeline/queue.ts` (single worker; rejects duplicate events)
- [X] T022 [P] [US1] Implement classifier signals `src/pipeline/classifier/signals.ts` — flaky + infra rule lists (contracts/classification.md)
- [X] T023 [US1] Implement classifier `src/pipeline/classifier/index.ts` — rule-first category + confidence (≥ 0.7 threshold), evidence capture, persist to `classifications` and chain to SOR (T014)
- [X] T024 [US1] Implement orchestrator intake `src/pipeline/orchestrator.ts` — deploy → queue → open worktree at failing commit (direct `git worktree` shell calls) → classify → route flaky/real_bug/infra

**Checkpoint**: User Story 1 fully functional and testable independently

---

## Phase 4: User Story 2 - Flaky failures heal themselves, no human needed (Priority: P1)

**Goal**: Flaky runs rerun ≤ 3× via platform API; auto-resolve with comment when a rerun passes; escalate when exhausted.

**Independent Test**: Simulate fail-then-pass → `ci_runs.status = resolved` + flaky-resolved comment; simulate persistent failure → exactly 3 reruns then escalation (quickstart scenario A).

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T025 [P] [US2] Unit test retry budget in `tests/unit/retry_test.ts` (max 3 reruns, uses stubbed rerun API)

### Implementation for User Story 2

- [X] T026 [US2] Implement retry runner `src/pipeline/retry/runner.ts` — job rerun via `gh` api wrapper, max 3, update `ci_runs.status` (`retrying` → `resolved`), chain transitions to SOR
- [X] T027 [US2] Wire flaky routing in `src/pipeline/orchestrator.ts` — on rerun pass post flaky-resolved comment (comments.ts type 3); after 3 failures route to escalation with reason `flaky_retries_exhausted`

**Checkpoint**: User Stories 1 AND 2 both work independently

---

## Phase 5: User Story 3 - Small safe bugs get one auto-fix, proposed for human review (Priority: P1)

**Goal**: `real_bug` + confidence ≥ 0.7 + allowlist match (MVP: lint/format) → exactly ONE verified fix on `ci-fix/<run-id>` branch + CI-run comment; never a PR or merge.

**Independent Test**: Push a lint/format failure on a non-critical branch → `ci-fix/<run-id>` branch exists on origin, fix comment posted, no PR opened (quickstart scenario B).

### Tests for User Story 3

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T028 [P] [US3] Unit test allowlist + one-attempt cap in `tests/unit/fixscope_test.ts` (enforces contracts/fix-attempt.md rules)
- [X] T029 [P] [US3] Integration test lint-fix loop in `tests/integration/lintfix_test.ts` (quickstart scenario B)

### Implementation for User Story 3

- [X] T030 [US3] Implement allowlist registry `src/pipeline/fixscope/allowlist.ts` — data-driven pattern entries; MVP ships `lint/format` only (contracts/fix-attempt.md)
- [X] T031 [US3] Implement lintfixer `src/pipeline/fixscope/lintfixer.ts` — run formatter in the worktree, verify (lint exits 0, diff non-empty), commit + push `ci-fix/<run-id>` via git worktree
- [X] T032 [US3] Implement fix-attempt persistence `src/pipeline/fixscope/record.ts` — write to `fix_attempts` (unique per run) and chain to SOR; reusable branch-name util
- [X] T033 [US3] Wire real_bug path in orchestrator: guardrail → fix → verify → post fix-delivered comment (comments.ts type 1); verification failure → escalate with reason `fix_failed` (no second attempt — DB unique enforces)

**Checkpoint**: User Story 3 works independently — auto-heal loop complete

---

## Phase 6: User Story 4 - Everything else escalates with a clear write-up (Priority: P1)

**Goal**: All escalation triggers (low_confidence, fix_failed, multi_file, critical_branch, budget_exhausted, no_pattern_match, infra, checkout_failed) produce a CI-run comment with root cause + suggested next step.

**Independent Test**: Push a multi-file failure (or a failure on `main`) → escalation comment with the right `reason`; no fix attempted (quickstart scenarios C + D).

### Tests for User Story 4

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T034 [P] [US4] Unit test escalation reason mapping in `tests/unit/escalation_test.ts` (contracts/fix-attempt.md table)
- [X] T035 [P] [US4] Integration test escalation path in `tests/integration/escalation_test.ts` (quickstart scenarios C, D)

### Implementation for User Story 4

- [X] T036 [US4] Implement escalation writer `src/pipeline/escalation/writer.ts` — build summary + suggested_next_step from evidence, persist to `escalations` + SOR, post comment (comments.ts type 2)
- [X] T037 [US4] Wire all escalation triggers in `src/pipeline/orchestrator.ts`: low_confidence, infra, critical_branch, multi_file, no_pattern_match, budget_exhausted, checkout_failed → escalate

**Checkpoint**: User Stories 1–4 all work independently

---

## Phase 7: User Story 5 - Operators can audit every decision the agent makes (Priority: P2)

**Goal**: Every pipeline decision is reproducible from the audit trail; tampering is detectable.

**Independent Test**: Run `npm run sor:verify` → chain verifies; modify an earlier record → detected (quickstart scenario F).

### Tests for User Story 5

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T038 [P] [US5] Integration test SOR chaining for CI tables in `tests/integration/sor_ci_test.ts` (quickstart scenario F)

### Implementation for User Story 5

- [X] T039 [US5] Implement audit reconstruction helper `src/audit/reconstruct.ts` — rebuild what the agent saw/decided for a run from `ci_runs` + `classifications` + `fix_attempts` + `escalations`
- [X] T040 [P] [US5] Wire `sor:verify` npm script + document audit commands in README

**Checkpoint**: All user stories independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [X] T041 [P] Run full quickstart.md validation (scenarios A–G) and fix any gaps found — DB-backed scenarios validated (A-partial, B-partial, C, D, F): webhook contract, classification persistence, one-attempt cap, escalation, SOR verify + tamper detection; live-GitHub steps (worktree push, rerun/comment) deferred to a token-equipped environment (see README "Validation status")
- [X] T042 [P] Security hardening: timing-safe HMAC compare, secret-redaction tests for comments/logs, confirm zero secrets in fixtures
- [X] T043 [P] Documentation: README usage + finalize `.env.example`
- [X] T044 Commit hygiene check: confirm `.env` stays untracked; only `src/`, `specs/`, `.specify/` committed and pushed

---

## Phase 9: v1.3.0 Standalone Transition & Packaging (US6)

**Purpose**: Drop the Fleet clone + PostgreSQL entirely; ship as a zero-dependency standalone package with a CLI.

- [X] T045 Replace pg with `node:sqlite` — `src/db/sqlite.ts` wrapper (pg-shaped `query()`, `$N`→`?`, `now()`→unix-ms rewrite), `src/db/pool.ts` (Pool type + singleton), `src/db/migrate.ts` (DatabaseSync runner, package-relative `migrations/`)
- [X] T046 Rewrite migrations 017–023 as SQLite DDL (TEXT PKs with `randomblob`-hex defaults, INTEGER timestamps, `'skipped'` folded into 017, 021 no-op, 023 `watched_repos`)
- [X] T047 Standalone SOR — `src/sor/{events,signer,chain,verify,verifyCli,repairCli}.ts`: HMAC-SHA256 hash chain in SQLite, genesis seed idempotent, CLI verify/repair
- [X] T048 Standalone worktrees — `src/pipeline/worktree.ts` (direct `git worktree add/remove`), no Fleet imports anywhere
- [X] T049 [US6] CLI — `src/cli/{init,enable,start,status}.ts` + `src/daemonEntry.ts`: `init` (generate secrets → `.env` + SQLite DB + migrate), `enable --repo o/r` (reporter PR via GitHub API + `watched_repos`), `start` (foreground / detached `dist/daemon.mjs`), `status`
- [X] T050 [US6] Packaging — esbuild bundles to `dist/` (build-time only; zero runtime deps — Node type-stripping doesn't work under `node_modules`, so TS can't ship raw), `bin/self-healer.mjs` pins `SELF_HEALER_PKG`, `"files"` = bin/dist/migrations/assets/.env.example
- [X] T051 [US6] Global-install validation — `npm pack` → `npm i -g` → `init`/`status`/`start` from a fresh project; daemon boots from `dist/daemon.mjs` under node_modules; webhook accepts on `:3457`
- [X] T052 Verify standalone end-to-end — typecheck clean, 88/88 tests, `sor:verify` `ok: yes`, `migrate:up`/`down` idempotent, SOR tamper test green on SQLite
- [X] T053 CLI test coverage — `src/cli/args.ts` (pure `parseCliArgs`, both `--repo o/r` and `--repo=o/r` forms — regression for the live-found parsing bug), `renderEnvFile`/`generateSecret`, `registerWatched` upsert vs `watched_repos`, `status` output rendering (DB-gated). Also fixes a dev-CLI side effect: the `src/index.ts` direct-run guard no longer matches `src/cli/index.ts`, so `tsx src/cli/index.ts status|help|init` no longer boots a background daemon

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3–7)**: All depend on Foundational phase completion
  - Implement sequentially in priority order (P1 → P2): US1 → US2 → US3 → US4 → US5
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories (intake is the entry point)
- **User Story 2 (P1)**: Depends on US1 (needs flaky classification routing) - independently testable once US1 exists
- **User Story 3 (P1)**: Depends on US1 (real_bug path) + shared escalation writer from US4 for its `fix_failed` case; the fix-delivered path itself only needs foundational comments.ts
- **User Story 4 (P1)**: Depends on US1 (classification routing) - independently testable via quickstart C/D
- **User Story 5 (P2)**: Depends on US1–US4 (needs real decision records to audit)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Models/schema before services; services before pipeline wiring
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational migrations marked [P] (T007–T009) can run in parallel
- Contract + unit tests within a story (marked [P]) can run in parallel
- T022/T018 [US1], T025/T026 logic can be developed in parallel once types exist
- T028/T029 [US3] and T034/T035 [US4] are independent of each other — parallelizable after US1
- Polish tasks T041–T044 are fully parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Contract test for webhook endpoint auth + response codes in tests/integration/webhook_test.ts"
Task: "Unit test classifier signals + confidence scoring in tests/unit/classifier_test.ts"

# Launch independent implementation files together:
Task: "Implement normalization src/webhook/normalize.ts"
Task: "Implement classifier signals src/pipeline/classifier/signals.ts"
```

---

## Implementation Strategy

### MVP First (Constitution-Defined Loop)

The constitution defines MVP done as: webhook → worktree → classifier (flaky vs. real_bug, infra stubbed) → retry runner → lint/format-only fix → escalation comment, end-to-end with tests.

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phases 3–6: User Stories 1–4 (all P1 — this IS the MVP loop)
4. **STOP and VALIDATE**: Run quickstart.md scenarios A–G; `sor:verify` passes
5. Deploy/demo

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 (intake + classify) → Test independently → checkpoint
3. Add User Story 2 (flaky retry) → Test independently → checkpoint
4. Add User Story 4 (escalation) → Test independently → checkpoint
5. Add User Story 3 (lint auto-fix) → closes the auto-heal loop → run full quickstart
6. Add User Story 5 (audit reconstruction) → Test independently
7. Polish (Phase 8)

Each story adds value without breaking previous stories.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (intake + classifier — mandatory first)
   - Developer B: User Story 4 tests + reason mapping (parallel after US1 types exist)
   - Developer C: User Story 2 (retry runner)
3. Then Developer A/B: User Story 3 auto-fix; Developer C: User Story 5
4. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- **Parallel rule (constitution 1.1.0)**: subagents may run `[P]` tasks in parallel only when they touch different files; never let two agents edit the same file simultaneously — serialize or merge same-file work.
- Self-Healer is standalone — all source + `specs/` + `.specify/` are committed; `.env`, `.runs`, `node_modules` stay gitignored; no Fleet clone needed