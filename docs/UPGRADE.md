# Upgrade: rule-based fixer → AI repair agent

| Area | Before | Now |
|---|---|---|
| Brain | none (regex allowlist) | Gemini / OpenRouter / Ollama, tool-calling loop (`src/llm`, `src/agent`) |
| Selection | – | `self-healer.config.json`: global default → `owner/*` → `owner/name` override; env fallback |
| Fix scope | lint/format + import/type | any failure: logic, types, tests, deps |
| Gate | verify command per pattern | **full suite** (+ `verifyCommands`) must pass in the worktree before any push |
| Delivery | fix PR opened | push to `ci-fix/<id>` + CI comment + **best-effort fix-only PR** (falls back to branch + comment; never merged) |
| Retry | one attempt | CI failure on the pushed branch → same pipeline again, capped (`maxFixCycles`, default 3, per-repo override) → `retry_cap_exceeded` |
| Budget | 3 model calls / 10 min | `maxLlmCalls` 40 / `maxToolCalls` 80 / 20 min (configurable) |
| Memory | outcome events | + reasoning trace in the SOR chain (`ci_agent_*`) + per-repo `repo_notes` |

## Pipeline
webhook → classify (rules; flaky→rerun, infra→escalate) → **agent** → gate → push → CI on `ci-fix/*` →
if it fails again: webhook → lineage (`parent_run_id`, `fix_cycle`) → agent (told what was tried) … → cap.

## Guardrails (enforced in code, not just in the prompt)
Protected branches never touched · push only `ci-fix/*`, never force · no test command ⇒ no push ·
`.github/`, `.git/` unwritable · deleting tests or adding skip/disable markers, committing
secrets, >1 MB files, or ≥ `maxFilesChanged` files ⇒ refused · self-reported confidence < 0.7 ⇒ not pushed ·
dependency/lockfile and edited-existing-test changes are flagged in the CI comment.

## Memory
* **Trace**: every model turn, tool call, gate result and decision is chained in the SOR log.
  Read it: `npm run audit:run <run-id>` ("Agent reasoning trace"). Note: this records the model's
  *stated* rationale (visible text + the `rationale` field of `finish`), not hidden chain-of-thought.
* **Notes**: table `repo_notes`. The agent adds ≤3 per run; pipeline adds flaky-job notes; a fix that
  fails in CI lowers the confidence of the notes behind it; near-duplicates merge and gain confidence.
  Relevant notes are retrieved by keyword/file overlap. Humans can steer:
  `self-healer notes list|add|retire --repo o/r`. Notes are treated as untrusted hints in the prompt.

## Config keys
See `self-healer.config.example.json`. Provider ∈ {gemini, openrouter, ollama}; keys/URLs stay in env.

## Legacy code
`lintfixer`, `importfixer`, `allowlist`, `fixpr` remain in the tree, unused by the pipeline
(their tests still pass). Delete them once you are happy with the agent.

## Constitution
Principles II (allowlist, one attempt), V (fix PR) and the 3-call LLM cap are superseded — see
`.specify/memory/constitution.md` v2.0.0; record it with `npm run sor:amend:v2`.

## Not done / known limits
* No signal when CI *passes* on `ci-fix/*` (only failures arrive), so notes are not reinforced on success.
* Ollama models must support tool calling; there is no one-shot fallback (by design choice).
* Python/Go/Rust dependency install is not auto-detected — set `installCommand`.
