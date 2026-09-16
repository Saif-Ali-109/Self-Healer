# Contract: Fix Attempt (guardrail + delivery)

**Branch**: `001-self-healer-ci-agent` | **Contract version**: 1.0 | **Plan**: [plan.md](../plan.md)

## Purpose

The contract governing the auto-fix path: allowlist matching, the single attempt, verification, and branch → fix-PR → comment delivery. Nothing in this path merges (constitution principle V); the fix PR is opened so a human can review and approve it.

## Allowlist (pattern registry)

MVP ships the `lint/format` and `import/type` patterns; others are added one at a time with validation + tests.

| ID | Pattern | Detection | Verification |
|---|---|---|---|
| `lint/format` | Linter/formatter failure (biome, eslint, prettier) with fixable diagnostics | exit code + output of the lint command | re-run linter (`npx @biomejs/biome check .`) → must exit 0, diff non-empty |
| `snapshot` | Outdated snapshot/golden file mismatch (post-MVP) | test output mentions snapshot mismatch | re-run affected test |
| `import/type` | Missing import — a symbol referenced but not imported at runtime | `ReferenceError: X is not defined` | re-run the failing command in the worktree (e.g. `node src/main.mjs`) must exit 0; diff = one file |
| `timeout` | Test timeout too low for a legitimately slower operation (post-MVP) | timeout error + timing evidence | re-run affected test |

Pattern entries are data-driven (a registry, not an if/else chain), and fixer selection is keyed off `pattern.id` — each active pattern owns its fixer (`applyLintFix`, `applyImportFix`), so a new pattern ships without touching routing, retry, queue, budget, or PR logic.

**`verifyCommand` semantics**: every active pattern carries a `verifyCommand` — the repro command that failed in CI, executed inside the worktree *after* the fix. Exit 0 verifies the fix; the same string is used in CI-run comments and PR text. Per-pattern defaults are fixed in the registry (`lint/format` → `npx @biomejs/biome check .`; `import/type` → `node src/main.mjs`). The `import/type` default follows the demo-repo repro convention: the demo repo is CJS-default (no `"type": "module"`), and the demo scenario uses `.mjs` files so ESM works without a repo-wide type switch.

## Fix attempt record

```jsonc
{
  "run_id": "uuid",
  "pattern_matched": "lint/format",
  "diff": "…exact diff…",
  "branch": "ci-fix/<run-id>",        // reusable per repo, per constitution
  "verification_result": "passed",    // 'passed' | 'failed'
  "test_summary": "biome check --write: 3 files fixed, exit 0",
  "comment_url": "https://github.com/o/n/actions/runs/1234567890#…",
  "attempted_at": "2026-09-13T12:05:00Z"
}
```

## Rules (hard, database + pipeline enforced)

1. **At most one fix attempt per failure** — `uq_fix_attempts_run` unique index on `run_id`; pipeline never issues a second.
2. **Fix scope guardrail** — fix is attempted only when the failure matches an allowlisted pattern. No match → escalate with `no_pattern_match`.
3. **Preconditions to attempt**: classification `real_bug` AND confidence ≥ 0.7 AND failure touches < 5 files AND branch is not critical (`main`, `release/*`, `v*`) AND fix budget available AND no prior failed attempt.
4. **Verification** — execute the pattern's `verifyCommand` (the repro command that failed) in the worktree; it must exit 0 before delivery. Fail → escalate with `fix_failed`, no second attempt.
5. **Delivery** — commit to `ci-fix/<run-id>` branch (recreated/updated per run), push, open a fix-only PR from `ci-fix/<run-id>` to the failing branch for human review, then post a CI-run comment containing: root cause, branch name, diff summary, test results, and the fix PR link. Never merge.
6. **Audit** — the attempt, diff, and verification result are persisted to `fix_attempts` and chained through SOR.

## Escalation reasons mapping

| Guardrail outcome | Escalation `reason` |
|---|---|
| No pattern match | `no_pattern_match` |
| Verification failed | `fix_failed` |
| ≥ 5 files in failure | `multi_file` |
| Critical branch (`main`, `release/*`, `v*`) | `critical_branch` |
| 3 LLM calls used | `budget_exhausted` |
| Confidence < 0.7 | `low_confidence` |
| Infra signal | `infra` |
| Flaky still failing after 3 reruns | `flaky_retries_exhausted` |