# Self-Healer CI Agent

> A CI failure agent that classifies every failure (`flaky` / `real_bug` / `infra`), retries
> flaky runs up to 3×, auto-fixes allowlisted bugs on a `ci-fix/<run-id>` branch, opens a
> **fix-only pull request for human approval** (the robot never merges), and logs every
> decision in a tamper-evident SOR audit chain.

Fully standalone Node.js daemon: persistence via `node:sqlite` (built into Node 22+),
git worktrees for isolated fixes, and the SOR audit chain stored in SQLite. No Fleet
clone, no PostgreSQL server, no runtime dependencies beyond Node itself.

Governed by the project [Constitution v3.0.0](.specify/memory/constitution.md), which caps the
agent's autonomy: ≤ 40 LLM calls / ≤ 80 tool calls / 20 minutes per run, ≤ 3 flaky reruns,
≥ 0.7 confidence to fix, a single FIFO worker, and best-effort fix-PR delivery
(falls back to branch + comment; the agent never merges).

---

## 🧠 AI agent upgrade (v2)

Self-Healer now diagnoses and fixes **any** CI failure with an LLM tool-calling agent
(Gemini, OpenRouter or Ollama — chosen globally and/or per repo in
`self-healer.config.json`), verifies with the **full test suite**, pushes to
`ci-fix/<run-id>` and opens a best-effort **fix-only PR** for human review (never merged,
falls back to branch + comment), re-fixes if CI still fails (capped,
default 3), and remembers per-repo notes. Details: [docs/UPGRADE.md](docs/UPGRADE.md) ·
deployment on a VPS with systemd: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) ·
example config: `self-healer.config.example.json`.

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
        ├── real_bug   ──▶  AI agent fixes in worktree → gate (full suite) → push ci-fix/<run-id>
        │                  →  best-effort fix-only PR (fallback: branch + comment) → human merges  |  escalate
        └── infra      ──▶  escalate (infra)
```

Every decision — classification, retry, fix attempt, escalation — is appended to the
append-only SOR hash chain in SQLite (`npm run sor:verify` proves tamper-freeness,
`npm run audit:run` reconstructs a single run end-to-end).

---

## Constitution guardrails (v3.0.0)

| Guardrail | Enforcement |
|-----------|-------------|
| Classification is rule-augmented, evidence recorded | regex signals + confidence in SOR, never silent |
| The AI agent fixes any CI failure (bounded) | `PipelineBudget` + `maxLlmCalls`/`maxToolCalls`/time limits; other paths escalate |
| ≤ 40 LLM calls / ≤ 80 tool calls / 20 min per run | `PipelineBudget` + `AgentLimits`, configurable per repo |
| ≤ 3 flaky reruns | `MAX_RERUNS` hard cap |
| ≥ 0.7 confidence to fix | classifier thresholds |
| One fix attempt per run | DB unique `uq_fix_attempts_run` |
| Never touch protected branches | `main` / `release/*` / `v*` are never auto-fixed |
| Never edit CI definition files | e.g. `.github/workflows/*` are out of fix scope |
| Robot never merges | fixes ship as best-effort PRs or branch + comment; a human reviews and merges |
| Tamper-evident audit | SOR hash chain in SQLite (verified on every `sor:verify`) |

Webhooks from the agent's own `ci-fix/*` branches are ignored, and only repositories that
carry the `self-healer-notify.yml` workflow trigger the daemon — so the agent can never loop
on its own output.

---

## Fix patterns

The fix-scope allowlist (`src/pipeline/fixscope/allowlist.ts`) ships **three active patterns**
(a general LLM repair agent plus two deterministic fixers) and two post-MVP stubs:

| Pattern | Detection | Fix | Verification |
|---------|-----------|-----|--------------|
| `ai-agent` | any real bug within scope after rule-first classification `real_bug` | LLM tool-calling agent diagnoses + fixes in one worktree | full suite green (`npm test: passed` → gate) |
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

1. A failing job is classified `real_bug` (rule-first, ≥ 0.7) and handed to the repair agent.
2. The agent fixes it in a worktree at the failing commit; the **full test suite** must pass.
3. The fix is pushed to `ci-fix/<run-id>` (based on the *failing* branch) — never forced.
4. A **best-effort fix-only PR** opens from `ci-fix/<run-id>` to the failing branch, titled
   `🤖 Self-Healer: auto-fix for CI run #<run-id>`. If it can't open (network, cross-fork
   commit, permissions, head == base), delivery falls back to the branch + CI comment.
5. A comment is posted on the failing run with root cause, reasoning, diff summary,
   verification output, and the fix-PR link when one was opened.
6. **A human reviews and merges.** The agent never merges — not even its own PRs — and
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

### Run under systemd (production / crash-proof)

`self-healer start` spawns a detached child that **nothing restarts** if it crashes — a
dead daemon with a live Cloudflare tunnel silently drops webhooks. For supervised
running, use a systemd **user unit** (mirrors the existing `openclaw-gateway.service` on
this machine — systemd 255, `Linger=yes`):

```ini
# ~/.config/systemd/user/self-healer.service
[Unit]
Description=Self-Healer CI Agent (webhook :3457 + FIFO worker)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=/home/ain/.nvm/versions/node/v22.22.2/bin/node /absolute/path/to/self-healer/dist/daemon.mjs
WorkingDirectory=/absolute/path/to/self-healer
Restart=always
RestartSec=3
TimeoutStopSec=30
Environment=HOME=/home/ain
Environment=PATH=/usr/bin:/home/ain/.nvm/versions/node/v22.22.2/bin:/home/ain/.local/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now self-healer   # start now + at boot (Linger)
systemctl --user status self-healer         # is it up? (use this, not `status`)
journalctl --user -u self-healer -n 50      # logs
```

Under systemd, manage the daemon with `systemctl --user stop/start/restart self-healer`
— do **not** use `self-healer start|stop` (the detached child would double-bind `:3457`),
and `self-healer status` shows `stopped` because the pid file is only written by the CLI
spawn path. Start the Cloudflare tunnel only after the daemon is ready:
`scripts/start-stack.sh` (waits for `GET /health` → 200, then launches
`cloudflared tunnel --url http://localhost:3457`).

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
npm run migrate:up              # applies migrations 001–024
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

Readiness: `GET /health` → `200 {"ok":true}` (no auth). Because the server only binds
after the DB connects, a reachable `/health` means the daemon is fully ready — use it in
startup ordering / supervisors instead of probing the POST route for 401/404.

### Testing the webhook locally

```bash
curl -fsS http://127.0.0.1:3457/health          # → {"ok":true} (200)
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
  db/               SQLite wrapper + migration runner (migrations 001–024)
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
| `test` | `multiply(2, 3)` returned `5` (`src/calc.js` shipped `return a + b`) | **AI agent** diagnosed & fixed → **PR #40** (`ci-fix/97df1109`), verified `npm test` | open for human merge (never auto-merged) |

The demo also proved: one clean handling cycle per failure (exactly one comment + one PR per
run), no duplicate comments, no comments on `ci-fix/*` PRs, and pattern-aware root-cause
lines in fix comments (`**Pattern matched**: import/type`).

### 🎉 First AI-agent auto-fix delivered: PR #40

The milestone run that took the whole pipeline **live end-to-end with the LLM repair agent** —
a real regression was planted in `src/calc.js` (`multiply` returned `a + b`), CI failed on
`npm test`, and the daemon went through the entire loop unattended:

| Time (UTC) | Elapsed | Stage |
|-----------|---------|-------|
| `14:08:56` | — | webhook received, `ci_runs` row created |
| `14:09:02` | 6 s | classified `real_bug` (confidence 0.9) |
| `14:09:06` | 10 s | agent loop starts (`groq/gpt-oss-120b`) |
| `14:09:06 → 14:10:30` | ~84 s | 7 tool-loop steps: diagnose → `edit_file` → `run_command npm test` |
| `14:10:33` | — | fix verified (`npm test: passed`), SOR notes written |
| `14:10:40` | **1 min 44 s** | **resolved → PR #40 opened** |

**The fix landed as PR #40** — <https://github.com/Saif-Ali-109/demo-repo/pull/40>
(base `demo-real-bugs`, head `ci-fix/97df1109`, one file `src/calc.js`):

```diff
 function multiply(a, b) {
-  return a + b; // BUG: should be `return a * b`
+  return a * b;
 }
```

Recorded in the SOR chain (decision `finish_accepted`, confidence 1): root cause *"multiply
returned the sum of its arguments rather than the product"*, verification `npm test: passed`.
Per the constitution the fix-only PR is **open for human review and merge** (the robot never
merges) and a comment carrying root cause + reasoning + verification was posted back on the
failing run (PR #39 thread, `issuecomment-5796381118`).

Why it one-shot in under two minutes: the context window stayed tiny across the whole loop
(2,595 → 3,355 input tokens — far under every Groq free-tier cap), the worktree was clean
(`.gitignore`d `node_modules`/`package-lock`), and the test script ran the unambiguous bare
`node --test` form. Note the lab config widens `pipelineBudgetMs` to 40 min purely as
free-tier request-pacing headroom; providers that stay within per-minute caps still finish in
~1–3 min.

---

## Validation status

- **Tests**: 132 passing (`npm test`) comprising unit tests for classifier, retry budget,
  fix scope, fixer detection, escalation, comments, security, webhook contract (incl.
  `GET /health` readiness), CLI (arg
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
  GitHub Actions runs. First full **AI-agent** delivery: run `97df1109` on `Saif-Ali-109/demo-repo`
  — classified `real_bug`, fixed the planted `multiply` bug in `src/calc.js`, verified
  `npm test`, pushed `ci-fix/97df1109`, opened **PR #40**, commented back on the failing run —
  **webhook → PR in 1 min 44 s** on `groq/gpt-oss-120b`.

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