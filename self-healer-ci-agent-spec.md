# Self-Healer CI Agent — Project Spec (as-built, v2)

> When CI fails, the agent pipeline investigates the failure, classifies it
> (`flaky` / `real_bug` / `infra`), and either reruns the flaky job (≤ 3×), auto-fixes a
> real bug with an LLM repair agent verified by the **full test suite** (a fix-only PR for
> human approval), or escalates with a clear root-cause write-up — every decision chained
> into a tamper-evident SOR audit log.

## 1. What it is (standalone stack)

A **fully standalone Node.js daemon** — no Fleet, no PostgreSQL server, no runtime
dependencies beyond Node ≥ 22.18:

| Concern | Implementation |
|---|---|
| Language | TypeScript 5.7 strict, ESM, `node >= 22` |
| Database | `node:sqlite` (built into Node 22+, zero deps) |
| Git worktrees | Direct `git worktree add/remove` shell calls at the failing commit |
| SOR audit | Append-only HMAC hash-chain table in SQLite (`npm run sor:verify` proves integrity) |
| Webhook | Standalone `node:http` server on `CI_WEBHOOK_PORT` (default `3457`), HMAC-verified |
| Worker | Single FIFO worker, one failure at a time (no row locking) |
| Badge of life | `GET /health` → `200 {"ok":true}` (binds only after DB is ready) |

## 2. Pipeline (implemented)

```
GitHub Actions webhook  ──▶  POST /api/webhook/ci   (HMAC-verified, deduped by run+job)
        │
        ▼
   ci_runs (pending)  ──▶  FIFO single worker
        │
        ▼
   classify (rule-first: flaky / infra / real_bug, evidence + confidence)
        │
        ├── flaky      ──▶  rerun ≤ 3× via `gh api` → resolved + comment  |  escalate
        ├── real_bug   ──▶  AI repair agent in worktree → full-suite gate → push ci-fix/<run-id>
        │                  →  fix-only PR (fallback: branch + comment) → human merges  |  escalate
        └── infra      ──▶  escalate (infra)
```

Every step — enqueue, classification, agent reasoning/tool calls, fix attempt, notes
read/written, escalation — lands in the SOR chain (`ci_run_transition`, `ci_classification`,
`ci_agent_reasoning`, `ci_agent_tool`, `ci_agent_decision`, `ci_notes_read/written`,
`ci_fix_attempt`). `npm run audit:run -- <run-id>` reconstructs any run end-to-end.

## 3. Classifier (rule-first, evidence-logged)

- **Flaky signal**: same test passed on a previous run of the same commit/branch; known
  flaky history; timing/race patterns (timeout, connection reset, non-deterministic order).
- **Infra signal**: rate limit, disk full, docker pull failure, expired credentials, and
  other environment/quota patterns.
- **Real bug**: everything else — only real bugs enter the fix loop.
- **Confidence**: strong signal → 0.9, moderate → 0.75, conflicting → 0.5; the fix loop
  requires ≥ `FIX_CONFIDENCE_THRESHOLD` (0.7).
- The classifier is **rule-first and never requires an LLM**; it logs every category,
  confidence, and the evidence signals (`evidence` array) into `classifications`.

## 4. AI repair agent (v2 — the fix engine)

When a failure is `real_bug`, a provider-neutral **tool-calling LLM agent** runs in an
isolated git worktree checked out at the *failing* commit (`AGENT_VERSION = "agent-v1"`):

| Item | As built |
|---|---|
| Tools | `list_dir`, `read_file`, `search`, `run_command` (single command, no shell), `edit_file`, `write_file`, `finish`, `give_up` |
| Loop | model ⇄ tools until `finish` / `give_up` / budget / error; tool outputs compacted when context grows (`compactContext`) |
| Gate | `finish` runs the **full test suite** in the worktree; failures feed back and the agent keeps working (≤ 3 finish rejections) |
| Publish gate | self-reported confidence ≥ 0.7 required to push a fix |
| Limits | defaults `maxLlmCalls: 40`, `maxToolCalls: 80`, `maxFixCycles: 3`, `pipelineBudgetMs: 20 min` (lab config: 20 calls / 40 min for free-tier pacing) |
| Re-fix lineage | if CI fails again on a pushed fix branch, a new cycle runs against the previous attempt (fix_cycle, parent_run_id) |

### LLM providers

Chosen globally and/or per repo in `self-healer.config.json` — exactly four exist:

| Provider | Notes (learned from live free-tier use) |
|---|---|
| `gemini` | 3.1-flash-lite proved the fix end-to-end once; demand-spike 503s at peak hours — needs patient retries |
| `openrouter` | free-tier pools 429 under load |
| `ollama` | local, no quota — but needs a reachable server and is slower |
| `groq` | **delivered first full fix** (`gpt-oss-120b`); free-tier quirks handled in code: `max_tokens` capped at 512 (OTPM), CI-log excerpt trimmed to ~3.5k chars, message context capped at 10k chars, HTTP retries widened to 8, and per-minute + per-day token quotas (qwen 7k ITPM / 1k OTPM, both gpt-oss 8k TPM, 200k tokens/day) drove the trimming |

## 5. Memory & learning notes

The agent maintains **persistent per-repo notes** (`repo_notes` table — "notes for himself"):

- **Writes**: the agent adds 0–3 notes in `finish`/`give_up`; the pipeline writes system
  notes; humans add notes via `self-healer notes add` (human notes start at confidence 0.95).
  Kinds: `flaky_hint`, `root_cause`, `fix_recipe`, `gotcha`, `avoid`, `test_info`,
  `run_outcome`.
- **Reads**: before every fix run, notes are keyword-scored (jaccard over tokens vs. the
  failing log + job name) and the top ones injected into the task prompt as
  `## Notes from earlier runs (hints, verify before trusting)` (`ci_notes_read`).
- **Trust lifecycle**: near-duplicate notes merge and reinforce (+0.1 conf, capped 1.0);
  when a fix built on notes later fails, `penalizeRunNotes` decays them (×0.7) and retires
  any below 0.2; prunes past 300/repo.
- Notes are **DATA, not instructions**: secret-redacted, length-capped (300 chars), and
  framed as hints.
- CLI: `self-healer notes list|add|retire`.

## 6. Fix-scope (what the agent may touch)

Active patterns (allowlist) plus stubs:

| Pattern | Detection | Fix | Verification |
|---|---|---|---|
| `ai-agent` | any `real_bug` after rule-first classification | LLM tool-calling agent diagnoses + fixes in one worktree | full suite green (`npm test` → gate) |
| `lint/format` | biome / eslint / prettier diagnostics | auto-format the offending file(s) | `npx @biomejs/biome check .` |
| `import/type` | `ReferenceError: X is not defined` | add the single import line for `X`, sourced from the sole exporter file | `node src/main.mjs` (repo convention) |
| `snapshot` | — (stub) | — | — |
| `timeout` | — (stub) | — | — |

Anything else escalates with a suggested next step — the agent never guesses.

## 7. Delivery: approve-then-fix

1. `real_bug` → agent fixes in a worktree at the failing commit; the **full test suite** must pass.
2. Fix pushed to `ci-fix/<run-id>` (based on the *failing* branch) — never forced.
3. Best-effort **fix-only PR** titled `🤖 Self-Healer: auto-fix for CI run #<run-id>`;
   if the PR can't open (network, cross-fork, head == base), falls back to branch + CI comment.
4. Comment posted on the failing run: root cause, reasoning, diff summary, verification,
   PR link.
5. **A human merges.** The agent never merges; `ci-fix/*` webhook events are dropped so the
   agent never loops on its own branches.

## 8. Guardrails (non-negotiables)

- Hard cap: **1 auto-fix attempt per failure** (unique `uq_fix_attempts_run`).
- `main` / `release/*` / `v*` are never auto-fixed.
- CI definition files (`.github/workflows/*`) are never edited.
- Classifier and fix outcomes are always logged with evidence; no silent decisions.
- Confidence < 0.7 → escalate, never fix.
- ≤ 3 flaky reruns (`MAX_RERUNS`), ≤ 1 fix attempt, budgets stop the pipeline (partial
  evidence escalates).

## 9. Data model (SQLite, migrations 017–024)

| Table / file | Purpose |
|---|---|
| `ci_runs` (017) | run id, repo, commit, job, status, log_url, links |
| `classifications` (018) | category, confidence, evidence, classifier version |
| `fix_attempts` (019, 022) | one-per-run diff, branch, verification result, fix PR URL |
| `escalations` (020) | reason, summary, suggested next step |
| `ci_runs` skip status (021), `watched_repos` (023), agent upgrade (024: `repo_notes`, agent tables) | supporting schema |
| SOR hash chain | append-only audit across all of the above |

## 10. Operations

| Command | Purpose |
|---|---|
| `npm start` | webhook listener + worker daemon |
| `npm run build` | bundle CLI + daemon to `dist/` (esbuild, build-time only) |
| `npm run typecheck` / `npm test` / `npm run lint` | dev gates |
| `npm run migrate:up` | apply migrations 017–024 |
| `npm run sor:verify` / `npm run sor:repair` | audit-chain check / key-loss recovery |
| `npm run audit:run -- <run-id>` | reconstruct a past run |
| `self-healer init / enable / start / status / stop` | CLI lifecycle |
| `self-healer notes list/add/retire` | inspect / teach the agent's memory |
| `self-healer llm …` | provider inspection/override |

## 11. Live evidence (delivered against `Saif-Ali-109/demo-repo`)

| Job | Failure | Outcome |
|---|---|---|
| `lint` | formatting error in `src/widget.js` | auto-fix → **PR #33** (`ci-fix/…`) — merged by human |
| `import` | `ReferenceError: renderWidget is not defined` | auto-fix → **PR #34**, verified `node src/main.mjs` (exit 0) — merged by human |
| `flaky` | hardcoded intermittent failure | 3 reruns → escalate `flaky_retries_exhausted` (by design) |
| `unknown` | hardcoded demo error | no pattern → escalate `no_pattern_match` (by design) |
| `test` | **AI-agent, first full delivery** | run `97df1109` → fixed `src/calc.js` `multiply` (`a + b` → `a * b`), verified `npm test`, pushed `ci-fix/97df1109`, opened **PR #40**, commented on the failing run |

**Timing of the AI-agent delivery (webhook → PR #40)**: recorded at `14:08:56` UTC, classified
`real_bug` (0.9) at `14:09:02`, agent loop (7 steps, `groq/gpt-oss-120b`, input tokens
2,595 → 3,355) `14:09:06–14:10:30`, verified `npm test: passed`, resolved + **PR #40 opened at
14:10:40 — 1 min 44 s total.** The agent's learned note survives in `repo_notes`:
`[root_cause] "multiply incorrectly returned sum instead of product, causing test failure."`

## 12. Packaging roadmap

Standalone npm package (`self-healer-ci-agent`) or Docker image — **zero runtime
dependencies** (source bundled to plain JS; esbuild is a build-time devDependency; migrations,
`assets/self-healer-notify.yml`, and `.env.example` ship with the package; `bin/self-healer.mjs`
pins the package root). Requires Node ≥ 22.18.

## 13. Out of scope (current)

GitHub App form, multi-worker scaling, LLM-enriched classification beyond rule-first,
dashboard UI, and a live demo re-run harness. (A once-per-repo repo-map/index phase was
discussed separately and is **not** in this spec for now.)