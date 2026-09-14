# Self-Healer CI Agent

> CI failure agent that classifies failures (`flaky` / `real_bug` / `infra`), retries flaky
> runs up to 3×, auto-fixes allowlisted bugs on a `ci-fix/<run-id>` branch with a CI comment,
> never auto-PRs or merges, and logs every decision in a tamper-evident SOR audit trail.

Built on the local [Fleet](https://github.com/Saif-Ali-109/Self-Healer/tree/main/fleet) clone
(read-only dependency — Self-Healer reuses Fleet's SOR chain, git worktrees, and web dashboard
schema; Fleet source is never modified).

---

## Pipeline

```
GitHub Actions webhook  ──▶  POST /api/webhook/ci   (HMAC-verified)
        │  normalize + dedupe (external_run_id + repo + job_id)
        ▼
   ci_runs (pending)  ──▶  FIFO single worker (FOR UPDATE SKIP LOCKED)
        │
        ▼
   worktree at failing commit  ──▶  classify (rule-first: flaky / infra / real_bug ≥ 0.7)
        │
        ├── flaky      ──▶  rerun ≤ 3× via `gh api` → resolved + comment  |  escalate (flaky_retries_exhausted)
        ├── real_bug   ──▶  allowlist (MVP: lint/format) → 1 fix on ci-fix/<run-id> → verify → comment | escalate
        └── infra      ──▶  escalate (infra)
```

Constitution guardrails enforced: ≤ 3 LLM calls and 10-minute budget per run, ≥ 0.7
confidence to fix, one fix attempt per run (DB unique), protected branches never touched
(`main` / `release/*` / `v*`), 5+ file diffs escalate, branch + comment delivery only.

## Quick start

```bash
cp .env.example .env            # fill in REAL values (never commit .env)
npm install
npm run migrate:up              # applies Fleet 001–016 + Self-Healer 017–020
npm run start                   # webhook listener + single-worker daemon
```

Webhook endpoint: `POST /api/webhook/ci` on `CI_WEBHOOK_PORT` (default `3457`).

The handler validates an `X-Webhook-Secret` HMAC-SHA256 header and returns:

| Code | Meaning |
|------|---------|
| `202` | Accepted, `ci_runs` row created (idempotent response) |
| `400` | Non-failure event / invalid JSON / wrong event type |
| `401` | Missing or invalid webhook secret |
| `409` | Duplicate event (unique `external_run_id + repo + job_id`) |

### Testing the webhook locally

```bash
node --input-type=module -e '
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ action: "completed", workflow_job: { id: 42, run_id: 7, head_branch: "feature/x", head_sha: "abc", repo: { full_name: "acme/widget" }, name: "test", conclusion: "failure" } });
  const sig = "sha256=" + createHmac("sha256", process.env.CI_WEBHOOK_SECRET).update(body).digest("hex");
  const res = await fetch("http://127.0.0.1:3457/api/webhook/ci", { method: "POST", headers: { "content-type": "application/json", "x-webhook-secret": sig, "x-github-event": "workflow_job" }, body });
  console.log(res.status, await res.text());
'
```

## Configuration

All secrets live in `.env` (gitignored). Required:

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` | `gh` CLI auth: rerun jobs, post CI comments, push `ci-fix/*` branches |
| `CI_WEBHOOK_SECRET` | HMAC secret for `X-Webhook-Secret` header verification |
| `DATABASE_URL` | PostgreSQL connection string (Fleet schema 001–016 + Self-Healer 017–020) |
| `SOR_SIGNING_KEY` | Key that signs the SOR audit chain (same as Fleet) |

Optional: `SOR_KEY_ID` (default `v1`), `CI_WEBHOOK_PORT` (default `3457`),
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` (classifier enrichment is
rule-first; LLM keys enable optional model confirmation), `CI_POST_COMMENTS=0` (dry-run:
skip posting CI comments — used by tests; default is posting enabled).

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Run webhook listener + worker daemon |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit + integration tests (integration suites auto-skip without `DATABASE_URL`) |
| `npm run lint` / `npm run format` | Biome lint / format |
| `npm run migrate:up` / `migrate:down` | Apply / roll back migrations |
| `npm run sor:verify` | Replay-verify the SOR hash chain (`ok: yes` = tamper-free) |
| `npm run sor:repair` | Re-sign the chain under the current key (key-loss recovery only) |
| `npm run audit:run -- <run-id>` | Reconstruct what the agent saw/decided for a run |

### Audit reconstruction (US5)

Every pipeline decision is chained into Fleet's append-only SOR hash chain. To audit a run:

```bash
npm run audit:run -- <run-id>     # human-readable markdown from the 4 CI tables
npm run sor:verify                # chain integrity: detects any tampered record
```

Example record: a `ci_runs` event shows what the agent saw (repo, commit, branch, job
logs); `classifications` captures category + confidence + evidence; `fix_attempts` records
the one permitted attempt (diff, branch, verification result, comment URL); `escalations`
captures the reason + suggested next step. The SOR chain binds them all in order; any
modification is detected by `sor:verify` (an append-only DB trigger blocks in-app UPDATEs
as defense-in-depth).

## Validation status

Implemented and verified in this environment (PostgreSQL 16, local DB, tests green —
`npm test` 50/50, `sor:verify` ok):

- Webhook contract: valid payload → `202` + `ci_runs` row; wrong/missing secret → `401`;
  duplicate → `409`; non-failure / wrong event type / invalid JSON → `400`.
- Classifier: flaky + infra signal rules, confidence scoring (strong 0.9 / moderate 0.75),
  empty-log → `real_bug`.
- Retry budget: hard caps (3 reruns, 3 LLM calls, 10 min) enforced by `PipelineBudget` +
  constants; rerun loop caps at `MAX_RERUNS`.
- Fix scope: allowlist ships `lint/format` active (3 post-MVP stubs inert), one-attempt cap
  enforced by `uq_fix_attempts_run`, `ci-fix/<run-id>` branch naming.
- Escalation: all 9 reasons → suggested next step; DB persistence + SOR chaining.
- SOR: CI events chain into `audit_events`, `sor:verify` passes; tamper simulation
  (appending to a payload) is detected and recovers after restore.

Deferred to a live environment (needs a real GitHub token + actions runner):

- Push a real failing commit → observe the worktree push to `ci-fix/<run-id>` on origin.
- Flaky rerun + flaky-resolved comment against a live GitHub Actions run.
- Lint/format fix + fix-delivered comment against a live repo.
- Escalation comment posts (comment URLs are null without a live run).

## Implementation notes

- **Standalone webhook server, not mounted on Fleet's dashboard.** The contract path
  `POST /api/webhook/ci` would collide with Fleet's own dashboard route (`/webhook`), so
  Self-Healer runs its own `node:http` server on `CI_WEBHOOK_PORT`. `handleCiWebhook` is
  exported as a pure `(headers, rawBody) → { status, body }` function, so it can be mounted
  on Fleet's dashboard via its `ApiHandlers` interface without refactoring if desired.
- **Imports into Fleet, never out of it.** Self-Healer imports Fleet's SOR chain
  (`appendAuditEvent`, `ensureChain`, `verifyChain`) and git worktrees
  (`setupWorktree`/`cleanupWorktree`) via relative paths; Fleet stays unmodified and
  gitignored. Self-Healer installs its own `pg` to satisfy Fleet's transitive imports.
- **MVP allowlist = `lint/format` only** (contracts/fix-attempt.md). Snapshot-test and
  dependency-update patterns ship as inert registry stubs, activated post-MVP.
- **LLM usage is optional.** The classifier is rule-first (regex signals); LLM providers
  are configured for enrichment but never required for the core loop, keeping the
  constitution's 3-call cap trivially satisfiable.

## Development

```bash
npm run typecheck
npm test
npm run lint
npm run format
npm run sor:verify
```

DB-backed integration tests read `DATABASE_URL` (and `SOR_SIGNING_KEY`) from the
environment, falling back to a local `.env`; without them the suites skip cleanly.

## Architecture

See `specs/001-self-healer-ci-agent/plan.md` for the full technical design, and the
task checklist in `specs/001-self-healer-ci-agent/tasks.md`.