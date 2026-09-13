# Implementation Plan: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-self-healer-ci-agent/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command; its definition describes the execution workflow.

## Summary

When a CI job fails in a watched repository, a webhook notifies the agent, which classifies the failure (`flaky` / `real_bug` / `infra`) using rule-augmented signals, then either retries flaky runs (up to 3), auto-fixes real bugs that match a strict allowlist (one attempt, verified, delivered on a `ci-fix` branch with a CI-run comment — never a PR/merge), or escalates everything else with a root-cause comment. Every decision is recorded in Fleet's tamper-evident SOR hash-chain.

The technical approach reuses Fleet's existing TypeScript skeleton — the orchestrator pattern, child-process worker runtime, provider registry (Gemini → OpenRouter → Ollama), bash/read/write/edit/grep/glob tools, SOR hash-chain, and the dashboard server (which already exposes a `WebhookHandler` type) — and adds only the CI-specific slices: webhook listener + GitHub Actions adapter, classifier role, fix-scope guardrail with a lint/format fixer, retry runner, escalation writer, and four new database tables.

**MVP scope (per constitution §Development Workflow)**: webhook → worktree → classifier (flaky vs. real_bug, infra stubbed to escalate) → retry runner → **lint/format-only fix** → escalation comment. The pull of the full 4-pattern allowlist and live infra detection from the feature spec is phased after MVP, one pattern at a time.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.7 (strict, ESM, `"type": "module"`), Node.js ≥ 22 — identical to Fleet, which the agent reuses wholesale.

**Primary Dependencies**: Reused from Fleet without change — `pg` (PostgreSQL client), `openai` SDK v7 (provider shim for Gemini → OpenRouter → Ollama fallback), `@modelcontextprotocol/sdk` (MCP server core), `gh` CLI (wrapped via `node:child_process` in Fleet's `src/github/gh.ts`). Dev: `tsx`, `vitest` v3, `@biomejs/biome` v2, `typescript`. No new runtime dependencies for MVP.

**Storage**: PostgreSQL (Fleet's existing schema) — extend it with four tables: `ci_runs`, `classifications`, `fix_attempts`, `escalations` (new migrations `017`–`020`), all chained into Fleet's existing SOR hash-chain.

**Testing**: Vitest v3 (unit + integration), Biome for lint/format. Contract tests against fixture webhook payloads in `tests/fixtures/`.

**Target Platform**: Linux server, self-hosted single instance, long-running daemon process (Fleet's dashboard server hosts the webhook listener).

**Project Type**: daemon / web service (CI failure agent) that embeds Fleet's orchestrator + worker runtime rather than replacing it.

**Performance Goals**: One failure processed at a time (single worker, FIFO). End-to-end pipeline must complete within **10 minutes** per failure (per constitution); retries for flaky runs bounded at 3.

**Constraints**: ≤ 1 auto-fix attempt per failure; ≤ 3 LLM model calls per failure; classification confidence ≥ 0.7 required to proceed to fix; fix scope = full repo but human-review-gated; all secrets from environment variables; worktrees isolated + cleaned up; no PRs, no merges.

**Scale/Scope**: MVP loop — webhook → worktree → classifier (flaky/real_bug, infra stubbed) → retry runner → lint/format-only fix → escalation comment. 4 fix patterns total are covered by the spec; only lint/format is in MVP (others ship one at a time).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Constitution Rule | Status | How the plan satisfies it |
|---|---|---|
| I. CI-Agnostic Webhook Handling | ✅ PASS | Generic `WebhookHandler` + per-vendor adapter; GitHub Actions adapter first; logs pulled via `gh api`; worktree at failing commit; findings posted as CI-run comments via `gh api`. |
| II. Rule-Augmented Classification (NON-NEGOTIABLE) | ✅ PASS | Classifier is rule-first (flaky/infra signal lists), LLM only enriches; every classification logs category, evidence, confidence, classifier version to SOR. |
| III. Fix-Scope Guardrail (NON-NEGOTIABLE) | ✅ PASS | Auto-fix only for allowlist; MVP ships lint/format pattern with verification; anything else escalates; hard cap of ONE attempt per failure. |
| IV. Tamper-Evident Auditability | ✅ PASS | Every decision routed through Fleet's SOR `ingest`; new tables joined into the existing hash-chain; `sor:verify` validates. |
| V. Human-Approved Delivery | ✅ PASS | Delivery = push to reusable `ci-fix` branch + CI-run comment; no PR, no merge, ever. |
| LLC: 3-call cap | ✅ PASS | Budget counter enforced in pipeline; exhaustion → escalate with evidence. |
| LLC: Postgres + SOR | ✅ PASS | Four new tables extend Fleet schema; SOR chain reused unchanged. |
| LLC: Secrets via env only | ✅ PASS | `.env.example` documents all vars; `.env` gitignored; nothing secret logged. |
| LLC: Single worker FIFO | ✅ PASS | Webhook handler enqueues; one worker processes at a time; duplicate webhook events deduped by run id. |
| LLC: 10-min budget | ✅ PASS | Pipeline timer; timeout → stop + escalate with partial evidence. |
| LLC: Worktree isolation | ✅ PASS | Reuses Fleet's `git/worktree.ts`; cwd-locked tool access; cleaned up after pipeline. |
| Delivery: flaky → ≤3 retries | ✅ PASS | Retry runner reruns via `gh api` job rerun, max 3; still failing → escalate. |
| Delivery: infra → escalate | ✅ PASS | MVP stubs infra classification → immediate escalation with infra evidence. |
| Delivery: confidence ≥ 0.7 | ✅ PASS | Below threshold → escalate, never fix. |
| Delivery: escalation triggers (6) | ✅ PASS | All six triggers (low confidence, fix failed, 5+ files, critical branch, budget exhausted, no pattern match) route to escalation writer. |
| Dev: reuse Fleet, don't rebuild | ✅ PASS | Net-new code limited to webhook listener, classifier role, fix-scope guardrail, retry runner, escalation writer (per constitution). |
| Repo hygiene | ✅ PASS | Only self-healer source + `specs/` + `.specify/` committed; `fleet/` clone, `.opencode/`, `.env` gitignored. |

**Post-design re-check (after Phase 1)**: All 17 rows still PASS against the final design artifacts — the data model persists every decision with evidence (`data-model.md`), contracts encode the allowlist cap, 3-call/10-min budgets, comment-only delivery, and escalation reason mapping (`contracts/`), and `quickstart.md` validates each path including SOR verification. No violations introduced by design — no complexity justification required.

## Project Structure

### Documentation (this feature)

```text
specs/001-self-healer-ci-agent/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── webhook/             # NEW: CI failure intake
│   ├── server.ts        #   HTTP listener hosted by Fleet dashboard server
│   ├── adapters/
│   │   └── github.ts    #   GitHub Actions payload → normalized CI event
│   └── normalize.ts     #   shared CI failure event shape (adapter output)
├── pipeline/            # NEW: CI-specific orchestration wiring
│   ├── queue.ts         #   FIFO queue + dedupe (single worker)
│   ├── orchestrator.ts  #   reuses Fleet orchestrator pattern
│   ├── classifier/      #   NEW role: rule-augmented flaky/real_bug/infra
│   │   ├── signals.ts   #   flaky + infra signal rule lists
│   │   └── index.ts
│   ├── fixscope/        #   NEW: guardrail + lint/format fixer
│   │   ├── allowlist.ts
│   │   └── lintfixer.ts
│   ├── retry/           #   NEW: job rerun via `gh api`
│   │   └── runner.ts
│   └── escalation/      #   NEW: root-cause comment writer
│       └── writer.ts
├── db/
│   └── migrate.ts       #   extend with migrations 017–020
├── fixtures/            #   test webhook payloads
tests/
├── unit/
├── integration/
└── fixtures/
migrations/
├── 017_ci_runs.sql
├── 018_classifications.sql
├── 019_fix_attempts.sql
└── 020_escalations.sql
```

Reuse points (imported from the local `fleet/` clone via path alias, unchanged): `orchestrator.ts`, `runtime/worker`, `providers/registry.ts`, `git/worktree.ts`, `sor/*`, `dashboard/api.ts` (`WebhookHandler`), `github/gh.ts`, MCP server (extend tool allowlist with CI log/artifact fetch endpoints).

**Structure Decision**: Single TypeScript project in the Self-Healer repo root, mirroring Fleet's layout, that imports Fleet modules from the local `fleet/` clone (a dev-time dependency, gitignored, not pushed to GitHub). This keeps the "reuse, don't rebuild" rule literal while GitHub only receives Self-Healer's own source + spec docs. The alternative — vendoring Fleet's source into Self-Healer — was rejected because it duplicates the codebase and breaks the dependency relationship (see research.md).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations — tracked complexity is limited to the mandated net-new slices (webhook listener, classifier role, fix-scope guardrail, retry runner, escalation writer), which are required by the constitution and cannot be simplified below their current form.