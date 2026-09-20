# Implementation Plan: Self-Healer CI Agent

**Branch**: `001-self-healer-ci-agent` | **Date**: 2026-09-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-self-healer-ci-agent/spec.md`

## Summary

When a CI job fails in a watched repository, the agent classifies the failure (`flaky` / `real_bug` / `infra`) using rule-augmented signals, then either retries flaky runs (up to 3), auto-fixes allowlisted bugs on a `ci-fix/<run-id>` branch (verified in a worktree, surfaced as a fix-only PR for human approval, never merged), or escalates everything else with a root-cause comment. Every decision is recorded in a tamper-evident SOR hash chain stored in `node:sqlite`.

Self-Healer is a **standalone Node.js daemon** — no Fleet clone, no PostgreSQL server. Git worktrees are created via direct `git worktree` shell calls. The SOR chain is an append-only table inside SQLite.

## Technical Context

**Language/Version**: TypeScript 5.7 (strict, ESM, `"type": "module"`), Node.js ≥ 22.

**Primary Dependencies**: `node:sqlite` (built into Node 22+, zero extra dep), `tsx`, `vitest` v3, `@biomejs/biome` v2, `typescript`. No `pg`, no Fleet runtime dependency.

**Storage**: `node:sqlite` — single-file SQLite database with migrations 001–022. SOR hash chain is an append-only audit-events table with per-row hash chaining.

**Testing**: Vitest v3 (unit + integration), Biome for lint/format. DB-gated integration suites auto-skip when `DATABASE_URL` is absent (uses SQLite fallback path or skips cleanly).

**Target Platform**: Linux server, self-hosted single instance, long-running daemon process.

**Project Type**: standalone daemon / web service (CI failure agent).

**Performance Goals**: One failure processed at a time (single worker, FIFO). End-to-end pipeline must complete within 10 minutes per failure. Retries for flaky runs bounded at 3.

**Constraints**: ≤ 1 auto-fix attempt per failure; ≤ 3 LLM calls per failure; classification confidence ≥ 0.7 required to proceed to fix; fix scope = full repo but human-review-gated; all secrets from environment variables; worktrees isolated + cleaned up; no PR merges, only fix-only PRs.

**Scale/Scope**: Standalone loop — webhook/poll → worktree → classifier (flaky/real_bug, infra stubbed) → retry runner → allowlist fix → verify → fix-only PR → human merge. Two active patterns (`lint/format`, `import/type`) + two stubs (`snapshot`, `timeout`).

## Constitution Check

| Constitution Rule | Status | How the plan satisfies it |
|---|---|---|
| I. CI-Agnostic Webhook Handling | ✅ PASS | Generic webhook listener + GitHub Actions adapter; daemon also polls GitHub Actions for failed runs on watched repos. |
| II. Rule-Augmented Classification (NON-NEGOTIABLE) | ✅ PASS | Classifier is rule-first (regex signals), LLM only enriches; every classification logged to SOR with evidence and confidence. |
| III. Fix-Scope Guardrail (NON-NEGOTIABLE) | ✅ PASS | Auto-fix only for allowlist (`lint/format`, `import/type`); MVP ships both; anything else escalates; hard cap of ONE attempt per failure. |
| IV. Tamper-Evident Auditability | ✅ PASS | Every decision routed to SOR append-only hash chain in SQLite; `sor:verify` validates; tamper simulation detected and recovers. |
| V. Human-Approved Delivery | ✅ PASS | Delivery = fix-only PR on `ci-fix/<run-id>` + CI-run comment; no merge, ever. |
| LLC: 3-call cap | ✅ PASS | Budget counter enforced; exhaustion → escalate with evidence. |
| LLC: node:sqlite, no external DB | ✅ PASS | Single-file SQLite with migrations 001–022; SOR chain implemented directly. |
| LLC: Secrets via env only | ✅ PASS | `.env.example` documents all vars; `.env` gitignored; nothing secret logged. |
| LLC: Single worker FIFO | ✅ PASS | Webhook handler enqueues; one worker processes at a time; duplicate webhook events deduped by run id. |
| LLC: 10-min budget | ✅ PASS | Pipeline timer; timeout → stop + escalate with partial evidence. |
| LLC: Worktree isolation | ✅ PASS | Direct `git worktree add/remove` shell calls; cwd-locked tool access; cleaned up after pipeline. |
| Delivery: flaky → ≤3 retries | ✅ PASS | Retry runner reruns via GitHub Actions API, max 3; still failing → escalate. |
| Delivery: confidence ≥ 0.7 | ✅ PASS | Below threshold → escalate, never fix. |
| Dev: standalone, no Fleet | ✅ PASS | All logic implemented directly; Fleet clone not required. |
| Repo hygiene | ✅ PASS | Only self-healer source + `specs/` + `.specify/` committed; `.env`, `node_modules`, `.runs` gitignored. |

## Project Structure

```text
src/
  webhook/          HMAC-verified webhook server + GitHub Actions adapter
  pipeline/
    queue.ts        FIFO worker queue
    orchestrator.ts classification → fix/retry/escalation dispatch
    classifier/     rule-first flaky / infra / real_bug
    retry/          flaky rerun budget
    fixscope/       allowlist + lintfixer + importfixer (pure detection + shell drivers)
    escalation/     reasons → suggested next step
  audit/            run reconstruction for auditing
  db/               SQLite pool-less access + migration runner (migrations 001–022)
tests/              unit + integration suites
specs/001-self-healer-ci-agent/
  spec.md           this feature spec
  plan.md           this file
  data-model.md     SQLite schema
  quickstart.md     validation guide
  contracts/        pattern contracts (fix-attempt.md, etc.)
  tasks.md          task checklist
  research.md       phase 0 research
```

## Migration Notes

Migrations 001–016 are bundled with Fleet but applied to the standalone SQLite database. Migrations 017–022 are Self-Healer's own tables:
- `017_ci_runs.sql` — `ci_runs` table
- `018_classifications.sql` — `classifications` table
- `019_fix_attempts.sql` — `fix_attempts` table
- `020_escalations.sql` — `escalations` table
- `021_ci_runs_skipped_status.sql` — `ci_runs.skipped_status`
- `022_fix_pr_url.sql` — `fix_attempts.fix_pr_url`
- `audit_events` — append-only SOR hash-chain table (created with 017)

SQLite types: `TEXT` for UUIDs and JSON, `INTEGER` for counts/timestamps, `REAL` for confidence scores. No `JSONB` or `gen_random_uuid()` — SQLite uses `LOWER(HEX(RANDOM()))` or application-side UUIDs.

---

# Addendum: Deployment Reliability Fix (connection-refused recovery) — 2026-09-20

> Implemented 2026-09-20 — **T058** (`/health`), **T059** (systemd unit), **T060**
> (`scripts/start-stack.sh`) done; **T061** live verification passed (SIGKILL restart
> 32263→32454, ~4s gap, tunnel untouched and still serving). Status tags below reflect
> post-implementation state. Future items (backfill, named tunnel, …) remain out of
> scope — see Deliverables (E).

## Problem (observed live)

While the cloudflared quick tunnel was up but the daemon was not yet started (or had
died), every webhook delivered to the tunnel printed:

```
ERR "Unable to reach the origin service ... dial tcp 127.0.0.1:3457: connect: connection refused"
```

The notify workflow (`assets/self-healer-notify.yml`) does a single one-shot `fetch` per
failed job — GitHub does **not** retry failed deliveries — so events landing in a down
window are silently lost. Root cause: **no supervision** — `self-healer start` spawns a
detached child (`src/cli/start.ts`) that nothing restarts on crash, and there is no
ordering between daemon readiness and tunnel startup.

## Status tags used below

- **already fixed** — shipped and verified before this plan
- **currently working** — present in the codebase, verified in use
- **recommended improvement** — planned change, not yet implemented
- **not yet verified** — designed but not proven on the target machine

## Deployment facts (verified on the target machine)

| Fact | Value |
|---|---|
| Init system | systemd 255 (Ubuntu); user session works; `Linger=yes` |
| Local precedent | `~/.config/systemd/user/openclaw-gateway.service` (user-level unit, nvm node) |
| Node | `/home/ain/.nvm/versions/node/v22.22.2/bin/node` (nvm; **no `current` symlink**) |
| Daemon bundle | `dist/daemon.mjs` (git-ignored; rebuilt via `npm run build`) |
| Daemon cwd | `/home/ain/Desktop/Self-Healer` |
| Env | `.env` at repo root (6 keys); `loadConfig()` reads `.env` from cwd → **no `EnvironmentFile` needed** |
| Tools | `gh`/`git` in `/usr/bin`; `npx`/`npm` in nvm bin (lintfixer needs them on `PATH`) |
| cloudflared | `/usr/bin/cloudflared` 2026.9.1, quick tunnel (`--url http://localhost:3457`), no config file |
| Webhook test home | `tests/integration/webhook_test.ts` (DB-gated, calls `handleCiWebhook`) |

## 1. Supervisor — systemd user unit ✅ (T059)

systemd is appropriate (verified: local precedent + Linger). Docker/PM2 rejected: no
runtime-dep goal; no Dockerfile in repo. Daemon runs as `ain`, owns `data/`, needs user
`HOME` → **user unit**, not system unit.

Proposed `~/.config/systemd/user/self-healer.service` (outside the repo):

```ini
[Unit]
Description=Self-Healer CI Agent (webhook :3457 + FIFO worker)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=/home/ain/.nvm/versions/node/v22.22.2/bin/node /home/ain/Desktop/Self-Healer/dist/daemon.mjs
WorkingDirectory=/home/ain/Desktop/Self-Healer
Restart=always
RestartSec=3
TimeoutStopSec=30
Environment=HOME=/home/ain
Environment=PATH=/usr/bin:/home/ain/.nvm/versions/node/v22.22.2/bin:/home/ain/.local/bin:/bin

[Install]
WantedBy=default.target
```

Operational consequence: once the unit is active, stop/start via
`systemctl --user stop/start self-healer` — do **not** use `self-healer stop|start`
(detached child would double-bind `:3457` → EADDRINUSE). `self-healer status` will show
`stopped` under systemd (pid file not written by the manager) — use
`systemctl --user status self-healer`.

## 2. Startup ordering ✅ (T060)

```
1. systemctl --user start self-healer
2. readiness loop:  curl -fsS http://127.0.0.1:3457/health        # expect 200 {"ok":true}
                    (fallback pre-/health: -X POST .../api/webhook/ci -d '{}' → 401)
3. cloudflared tunnel --url http://localhost:3457                 # capture printed URL
4. gh secret set SELF_HEALER_URL <printed-url> -R <owner/repo>    # quick-tunnel URL is session-random
```

`scripts/start-stack.sh` (repo, new; design only):

```bash
#!/usr/bin/env bash
set -euo pipefail
systemctl --user start self-healer
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3457/health || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-}" = "200" ] || { echo "daemon not ready after 30s (last=$code)"; exit 1; }
echo "▶ :3457 ready — starting cloudflared"
exec cloudflared tunnel --url http://localhost:3457
```

Expected readiness statuses: `/health` → 200; fallback probe → 401; anything else past
the timeout = abort before the tunnel starts.

## 3. Health endpoint — `GET /health → 200 {"ok":true}` ✅ (T058)

Better than 401/404 probes because 200 is an unambiguous "ready" contract: `startDaemon`
connects to the DB *before* binding the server, so 200 also implies DB readiness; 401/404
are semantically "wrong key / wrong path" and read as errors to supervisors. Also gives a
stable target for future named-tunnel ingress healthchecks.

`.specify/`-first order (per constitution §Development Workflow):
1. `specs/001-self-healer-ci-agent/tasks.md` → **T058** (+ contracts line)
2. `src/webhook/server.ts` → route beside the POST handler
3. `tests/integration/webhook_test.ts` → `GET /health → 200` test
4. `README.md` → validation-status line / test-count bump

## 4. Crash recovery matrix ✅ (T061 — SIGKILL test passed)

| Scenario | Restarts? | Why |
|---|---|---|
| Normal crash (exit ≠ 0) | ✅ | `Restart=always` |
| Unhandled exception | ✅ | No `uncaughtException` handler → process exits → restart |
| Process exit (even code 0) | ✅ | `Restart=always` restarts clean exits too |
| Machine reboot | ✅ | `WantedBy=default.target` + `enable` + Linger already yes |

Does **not** restart on: manual `systemctl --user stop`; crash-loop protection
(`StartLimitBurst=5`/60s → `failed`, needs `systemctl --user reset-failed`); host
shutdown; unit masked/disabled.

## 5. Webhook loss (not in this fix — future)

The supervisor + readiness gate **prevents** the persistent daemon-down-while-tunnel-up
state. It **cannot** prevent: the ~3s restart gap (a webhook landing mid-restart is still
refused/dropped), machine/network total outage (tunnel also down), or pre-fix history.
**Backfill on startup** (re-sweep recent failed `ci` runs per watched repo) is a separate
future feature; **not implemented here**.

## 6. cloudflared (external; no repo change)

Quick-tunnel invocation stays the same; only the start process gains a readiness gate.
Each cloudflared restart yields a new random URL → `SELF_HEALER_URL` must be re-set
(script step 4). **Named tunnel** (stable hostname; removes re-set step) requires a
Cloudflare account/domain — **not yet verified** as available; deferred.

## 7. Verification procedure ✅ (T061 — all steps run 2026-09-20)

1. `systemctl --user start self-healer` → `is-active` = `active`; journal shows
   `▶ CI webhook listening on http://0.0.0.0:3457/api/webhook/ci`.
2. Port: `ss -ltn | grep :3457` LISTEN; `curl -fsS http://127.0.0.1:3457/health` → `{"ok":true}`.
3. `scripts/start-stack.sh` → tunnel prints URL; external probe
   `curl -X POST <url>/api/webhook/ci -d '{}'` → 401.
4. Valid webhook: HMAC-sign `tests/fixtures/github-workflow-job-fail.json` with
   `CI_WEBHOOK_SECRET` (same code as `webhook_test.ts`) + `x-github-event:
   workflow_job` → 202 `{"ok":true,"run_id":...}`; `[worker] processing` in journal.
5. Crash → auto-restart: `systemctl --user kill -s KILL self-healer` → active again in
   ~5s; port re-listens; queue intact (WAL + FIFO re-picks pending rows).
6. Tunnel after restart: same public URL returns 401 again (no tunnel restart needed).
7. Honest residual gap: POST a signed webhook during the ~3s window → connection
   refused; after recovery → 202.

## Deliverables

**(A) Files to change**: `src/webhook/server.ts`; `tests/integration/webhook_test.ts`;
`specs/001-self-healer-ci-agent/tasks.md` (T058); `README.md` (validation status +
systemd note).

**(B) Files to add**: `~/.config/systemd/user/self-healer.service` (outside repo);
`scripts/start-stack.sh`.

**(C) Commands/config**: stop CLI-managed daemon first
(`node bin/self-healer.mjs stop`); `systemctl --user daemon-reload`; `systemctl --user
enable --now self-healer`; after source change `npm run build` +
`systemctl --user restart self-healer`; after each cloudflared restart
`gh secret set SELF_HEALER_URL <url> -R <owner/repo>`.

**(D) Verification**: the 7-step procedure above (real SIGKILL test + 3s-gap check).

**(E) Future improvements (not in this fix)**: backfill-on-startup; notify-workflow
delivery retry; named tunnel + ingress healthcheck; `uncaughtException` handler +
crash telemetry; `self-healer status` aware of systemd-managed daemon.
