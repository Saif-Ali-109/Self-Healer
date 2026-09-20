# Self-Healer CI Agent

> A CI failure agent that classifies every failure (`flaky` / `real_bug` / `infra`), retries
> flaky runs up to 3×, auto-fixes allowlisted bugs on a `ci-fix/<run-id>` branch, opens a
> **fix-only pull request for human approval** (the robot never merges), and logs every
> decision in a tamper-evident SOR audit chain.

Fully standalone Node.js daemon: persistence via `node:sqlite` (built into Node 22+),
git worktrees for isolated fixes, and the SOR audit chain stored in SQLite. No Fleet
clone, no PostgreSQL server, no runtime dependencies beyond Node itself.

Governed by the project [Constitution v1.3.0](.specify/memory/constitution.md), which caps the
agent's autonomy: ≤ 3 LLM calls per failure, ≤ 3 flaky reruns, ≥ 0.7 confidence to fix, a
10-minute budget per run, a single FIFO worker, and branch + comment delivery only.

---

## Pipeline

```
GitHub Actions webhook  ──▶  POST /api/webhook/ci   (HMAC-verified)
        │   normalize + dedupe (external_run_id + repo + job_id)
        ▼
   ci_runs (pending)  ──▶  FIFO single worker (no row locking)
        │
        ▼
   worktree at failing commit  ──▶  classify (rule-first: flaky / infra / real_bug ≥ 0.7)
        │
        ├── flaky      ──▶  rerun ≤ 3× via `gh api` → resolved + comment  |  escalate (flaky_retries_exhausted)
        ├── real_bug   ──▶  allowlist pattern match → apply fix → verify in worktree
        │                  →  open ci-fix/<run-id> fix PR → human approves & merges  |  escalate
        └── infra      ──▶  escalate (infra)
```

Every decision — classification, retry, fix attempt, escalation — is appended to the
append-only SOR hash chain in SQLite (`npm run sor:verify` proves tamper-freeness,
`npm run audit:run` reconstructs a single run end-to-end).

---

## Constitution guardrails (v1.3.0)

| Guardrail | Enforcement |
|-----------|-------------|
| Classification is rule-augmented, evidence recorded | regex signals + confidence in SOR, never silent |
| Only allowlisted patterns are auto-fixed | anything else escalates (`no_pattern_match`) |
| ≤ 3 LLM calls / failure | `PipelineBudget` + constants; LLM is optional enrichment |
| ≤ 3 flaky reruns | `MAX_RERUNS` hard cap |
| ≥ 0.7 confidence to fix | classifier thresholds |
| One fix attempt per run | DB unique `uq_fix_attempts_run` |
| Never touch protected branches | `main` / `release/*` / `v*` are never auto-fixed |
| Never edit CI definition files | e.g. `.github/workflows/*` are out of fix scope |
| Robot never merges | fixes ship as PRs; a human reviews and merges |
| Tamper-evident audit | SOR hash chain in SQLite (verified on every `sor:verify`) |

Webhooks from the agent's own `ci-fix/*` branches are ignored, and only repositories that
carry the `self-healer-notify.yml` workflow trigger the daemon — so the agent can never loop
on its own output.

---

## Fix patterns

The fix-scope allowlist (`src/pipeline/fixscope/allowlist.ts`) ships **two active patterns**
and two post-MVP stubs:

| Pattern | Detection | Fix | Verification |
|---------|-----------|-----|--------------|
| `lint/format` | biome / eslint / prettier diagnostics | auto-format the offending file(s) | `npx @biomejs/biome check .` |
| `import/type` | `ReferenceError: X is not defined` | add the single import line for `X`, sourced from the sole exporter file | `node src/main.mjs` (repo convention) |
| `snapshot` | — (stub, post-MVP) | — | — |
| `timeout` | — (stub, post-MVP) | — | — |

Each pattern's `verifyCommand` is **executed in the worktree after the fix**; exit 0 proves
the fix. The same command is echoed in the fix comment and PR body. The `import/type` fixer
is deliberately conservative:

- **Detection**: `ReferenceError: X is not defined` only, extracted from the failing job log.
- **Failing-file derivation**: stack-frame candidates from the log are validated against the
  worktree — the file must exist, reference the symbol, and appear in a real stack frame.
  Log noise (rescue-block echoes, doc comments that merely *mention* "import") is stripped
  before the exclusion check.
- **ESM-only**: `.mjs`/`.cjs`/`package.json` `type`/syntax sniffing — CommonJS targets bail
  cleanly instead of guessing.
- **Deterministic**: the import specifier is the on-disk relative path with extension; the
  exporter must be unambiguous (a single candidate), else the fix bails.

Anything without an allowlisted pattern escalates with a suggested next step — the agent
never guesses.

---

## Delivery: approve-then-fix

1. A failing job matches an allowlisted pattern.
2. The agent applies exactly one fix in a worktree at the failing commit and verifies it.
3. The fix is pushed to `ci-fix/<run-id>` (based on the *failing* branch) and surfaced as a
   **fix-only pull request** titled `🤖 Self-Healer: auto-fix for CI run #<run-id>`.
4. A comment is posted on the failing PR/run with root cause, pattern, diff summary,
   verification output, and the fix-PR link.
5. **A human reviews and merges.** The agent never merges — not even its own PRs — and
   `ci-fix/*` webhook events are dropped so the agent never reacts to its own branches.

---

## Quick start

### Install the package (standalone)

```bash
npm i -g self-healer-ci-agent      # zero runtime dependencies; needs Node ≥ 22.18
cd my-project
self-healer init                   # creates .env (secrets generated) + SQLite DB
self-healer enable --repo owner/repo   # reporter workflow PR (human merges) + watched
self-healer start                  # daemon: webhook :3457 + FIFO worker
self-healer status                 # db, queue, daemon, watched repos, SOR chain
self-healer stop                   # graceful stop (reads data/self-healer.pid)
```

### One-time setup: mute `ci` workflow notifications

When a watched `ci` workflow fails, GitHub emails everyone subscribed — and because the
agent reruns flaky jobs up to 3×, one run can produce several failure emails. This is normal
GitHub behaviour, not an agent problem, but it is noise for the team.

The workflow **keeps running and still reports to the agent** either way — you're only
silencing the emails:

1. Open the repo → **Settings → Actions → General → Notifications**.
2. Mute the `ci` workflow (or set a personal watch preference via the bell on any `ci` run).

That's it. Failures still reach the webhook, get classified, rerun, and fixed exactly as
before — the team just stops getting pinged on every flaky rerun.

### Or run from this repo (dev)

```bash
cp .env.example .env            # fill in REAL values (never commit .env)
npm install
npm run migrate:up              # applies migrations 001–023
npm start                       # webhook listener + single-worker daemon
```

Webhook endpoint: `POST /api/webhook/ci` on `CI_WEBHOOK_PORT` (default `3457`).

### Webhook contract

The handler validates an `X-Webhook-Secret` HMAC-SHA256 header and returns:

| Code | Meaning |
|------|---------|
| `202` | Accepted, `ci_runs` row created (idempotent response; `ci-fix/*` events → skipped) |
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

---

## Configuration

All secrets live in `.env` (gitignored). Required:

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` | `gh` CLI auth: rerun jobs, post CI comments, push `ci-fix/*` branches |
| `CI_WEBHOOK_SECRET` | HMAC secret for `X-Webhook-Secret` header verification |
| `DATABASE_URL` | SQLite database file path (default `./data/self-healer.db`) |
| `SOR_SIGNING_KEY` | Key that signs the SOR audit hash chain |

Optional: `SOR_KEY_ID` (default `v1`), `CI_WEBHOOK_PORT` (default `3457`),
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` (classifier enrichment — the
core loop is rule-first and never requires an LLM), `CI_POST_COMMENTS=0` (dry-run: skip
posting CI comments — used by tests).

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Run webhook listener + worker daemon |
| `npm run typecheck` | TypeScript strict check |
| `npm test` | Unit + integration tests (DB-gated suites skip without `DATABASE_URL`) |
| `npm run lint` / `npm run format` | Biome lint / format |
| `npm run migrate:up` / `migrate:down` | Apply / roll back migrations |
| `npm run build` | Bundle CLI + daemon to `dist/` (esbuild, build-time only) |
| `npm run sor:verify` | Replay-verify the SOR hash chain (`ok: yes` = tamper-free) |
| `npm run sor:repair` | Re-sign the chain under the current key (key-loss recovery only) |
| `npm run audit:run -- <run-id>` | Reconstruct what the agent saw/decided for a run |

### Audit reconstruction

Every pipeline decision is chained into the SOR hash chain in SQLite:

```bash
npm run audit:run -- <run-id>     # human-readable markdown from the 4 CI tables
npm run sor:verify                # chain integrity: detects any tampered record
```

A `ci_runs` event records what the agent saw (repo, commit, branch, job logs);
`classifications` captures category + confidence + evidence; `fix_attempts` records the one
permitted attempt (diff, branch, verification result, fix PR URL); `escalations` captures
the reason + suggested next step. The SOR chain binds them in order; `sor:verify` replays
every hash against the signing key and flags any tampered record.

---

## Repository layout

```
src/
  webhook/          HMAC-verified webhook server + GitHub Actions adapter
  pipeline/
    queue.ts        FIFO worker queue (no row locking — single writer)
    orchestrator.ts classification → pattern-matched fix / retry / escalation dispatch
    classifier/     rule-first flaky / infra / real_bug (LLM optional)
    retry/          flaky rerun budget
    fixscope/       allowlist + lintfixer + importfixer (pure detection layers + shell drivers)
    escalation/     reasons → suggested next steps, DB + SOR chaining
  audit/            run reconstruction for auditing
  db/               SQLite wrapper + migration runner (migrations 001–023)
  cli/              self-healer commands: init / enable / start / stop / status
  sor/              HMAC-SHA256 hash chain (verify / repair CLIs)
specs/001-self-healer-ci-agent/
  constitution→     .specify/memory/constitution.md (v1.3.0, the governing contract)
  plan.md / contracts/ / tasks.md / checklists/
tests/              unit + integration suites
```

---

## Live demo evidence

Verified end-to-end against a real GitHub repo (`Saif-Ali-109/demo-repo`) with the agent
running on its own daemon:

| Job | Failure | Agent outcome | Result |
|-----|---------|---------------|--------|
| `lint` | formatting error in `src/widget.js` | auto-fix → **PR #33** (`ci-fix/…`), opened for review | merged by human → job passes |
| `import` | `ReferenceError: renderWidget is not defined` | auto-fix → **PR #34**, verified with `node src/main.mjs` (exit 0) | merged by human → job passes |
| `flaky` | hardcoded intermittent failure | 3 reruns → escalate `flaky_retries_exhausted` | comment posted, by design |
| `unknown` | hardcoded demo error | no allowlisted pattern → escalate `no_pattern_match` | comment posted, by design |

The demo also proved: one clean handling cycle per failure (exactly one comment + one PR per
run), no duplicate comments, no comments on `ci-fix/*` PRs, and pattern-aware root-cause
lines in fix comments (`**Pattern matched**: import/type`).

---

## Validation status

- **Tests**: 131 passing (`npm test`) comprising unit tests for classifier, retry budget,
  fix scope, fixer detection, escalation, comments, security, webhook contract, CLI (arg
  parsing, `enable` watched-repo registration + reporter-PR argv, `status` rendering,
  `stop` + pid file, daemon-bundle single boot, package-root resolution), plus DB-gated
  integration suites
  (SOR chaining, tamper-recovery, audit reconstruction). DB-gated suites use
  `DATABASE_URL` from the environment or a local `.env` and skip cleanly when absent.
- **Typecheck**: `npm run typecheck` (tsc strict) clean.
- **SOR**: `npm run sor:verify` reports a tamper-free chain; tamper simulation is detected
  and recovers after restore.
- **Live**: webhook → worktree → classify → fix → verify → fix PR → human merge cycle and
  the flaky-rerun → escalate and no-pattern → escalate cycles all observed against live
  GitHub Actions runs.

---

## Development

```bash
npm run typecheck
npm test
npm run lint
npm run format
npm run sor:verify
```

New fix patterns follow the Constitution's own §Development Workflow: shipped **one at a
time**, each with a pure detection layer, unit tests, an integration fixture, and a contract
update in `specs/001-self-healer-ci-agent/contracts/` — no constitution version bump, no SOR
amendment.

## Architecture

See `specs/001-self-healer-ci-agent/plan.md` for the full technical design, and the task
checklist in `specs/001-self-healer-ci-agent/tasks.md`.