# Self-Healer CI Agent — Project Spec

## 1. One-line pitch
When CI fails, an agent pipeline investigates the failure, classifies it (flaky test / real bug / infra issue), and either retries, auto-fixes with a small diff + passing test, or escalates to a human with a clear root-cause writeup — all logged in an auditable trail.

## 2. What gets reused from Fleet (don't rebuild these)
| Fleet component | Reused as |
|---|---|
| Manager/orchestrator (`orchestrator.ts`) | Same role-pipeline coordinator pattern — swap the 6 roles for CI-specific ones |
| Worker runtime (child-process agent loop) | Unchanged — each role still runs as an isolated worker with tool access |
| Provider registry (Gemini → OpenRouter → Ollama fallback) | Unchanged, reuse as-is |
| Tools: bash/read/write/edit/grep/glob | Unchanged, still cwd-locked to a worktree |
| SOR (tamper-evident hash-chain audit log) | Unchanged — every classification, fix attempt, and decision gets logged the same way |
| Dashboard + SSE + TUI | Reused, just relabel events for CI stages instead of issue stages |
| MCP server pattern (`gh api` wrapper, allowlisted tools) | Reused, extend allowlist to include CI log/artifact fetch endpoints |

**Net new work is small**: a new trigger, a new classifier role, and a narrower auto-fix loop. Everything else is the same skeleton.

## 3. New pieces you need to build
1. **CI webhook listener** — receives failure events (GitHub Actions, CircleCI, etc.), pulls the failing job's logs + artifacts, opens a worktree at the failing commit.
2. **Classifier role** (new agent role, replaces "analyzer") — reads logs/stack trace, decides: `flaky`, `real_bug`, or `infra`. This is the key new intelligence piece.
3. **Fix-scope guardrail** — auto-fix is only attempted for narrow, low-risk cases (e.g., off-by-one, missing import, outdated snapshot, timeout too low). Anything else escalates. This keeps the "≤1 auto-fix" spirit from Fleet but with a stricter allowlist of fixable patterns.
4. **Escalation writer** — produces a human-readable root-cause summary + suggested next step when it can't or won't fix.

## 4. Pipeline (mirrors Fleet's analyzer→planner→coder→tester→reviewer→pr)

```
CI failure webhook
      │
      ▼
 [Classifier]  → reads logs, stack trace, recent diff
      │
      ├── flaky ──────────────► [Retry Runner] → reruns job N times
      │                              │
      │                       still fails? → escalate
      │
      ├── infra (env/quota/timeout) ─► [Escalate: infra ticket]
      │
      └── real_bug
              │
              ▼
        [Planner] → is this in the fixable-pattern allowlist?
              │
        ┌─────┴─────┐
       yes           no
        │             │
        ▼             ▼
   [Coder]        [Escalation Writer]
        │            (root-cause + PR-ready notes,
        ▼             posted as a comment/issue)
   [Tester] → run only the affected test(s) + full suite subset
        │
   ┌────┴────┐
  pass      fail (≤1 retry, same as Fleet's auto-fix cap)
   │          │
   ▼          ▼
[Reviewer]  [Escalation Writer]
   │
   ▼
 Open fix PR, linked to the original CI run, tagged "auto-fix"
```

## 5. Classifier logic (the heart of this project)
Keep it simple and rule-augmented rather than pure LLM judgment at first:
- **Flaky signal**: same test passed on a previous run of the same commit/branch, or test has a known flaky-tag/history of intermittent failures, or failure is a timing/race pattern (timeout, connection reset, non-deterministic order).
- **Infra signal**: error matches known infra patterns (rate limit, disk full, docker pull failure, credentials expired).
- **Real bug**: everything else — and only real bugs go to the fix loop.

Log every classification decision + the evidence used, exactly like DocPilot logs retrieval evidence — this gives you an eval set later (was the classification correct?).

## 6. Fixable-pattern allowlist (keep this tight at launch)
Only attempt auto-fix for:
- Outdated snapshot/golden file mismatches
- Missing/incorrect import or type error with an obvious single-line fix
- Test timeout too low for a legitimately slower operation
- Lint/formatting failures

Anything outside this list → escalate, never guess. This mirrors DocPilot's "validate or refuse" philosophy — an unvalidated fix is worse than no fix.

## 7. Data model additions (Postgres, extend Fleet's schema)
- `ci_runs` (run id, repo, commit, job, status, log_url, artifact_url)
- `classifications` (run id, category, evidence, confidence, classifier_version)
- `fix_attempts` (run id, pattern_matched, diff, test_result, retry_count)
- `escalations` (run id, reason, summary, linked_issue_url)

All chained into the same SOR hash-chain as Fleet's existing tables.

## 8. Guardrails / non-negotiables
- Hard cap: **1 auto-fix attempt per failure**, same as Fleet's existing rule.
- Auto-fix PRs are clearly labeled and never auto-merged — human approves.
- Classifier and fix-pattern match must both be logged with evidence; no silent decisions.
- If classifier confidence is below a threshold, default to escalate, not fix.

## 9. MVP scope (fastest path to a demo)
1. Webhook + worktree checkout (reuse Fleet's worktree logic)
2. Classifier role limited to flaky vs. real_bug (skip infra category at first)
3. Fix loop limited to ONE pattern only — lint/formatting failures (easiest to validate: run linter, done)
4. Escalation writer posts a comment on the failed CI run with root-cause + evidence
5. Dashboard reuses Fleet's existing SSE view, relabeled

Once that loop works end-to-end, add more fixable patterns one at a time (each is basically a new small tool + validation step, not a new architecture).

## 10. Suggested build order
1. Wire up webhook → worktree → classifier (no fixing yet, just classify + log)
2. Add retry runner for flaky path
3. Add escalation writer for real_bug path (this alone is useful/shippable)
4. Add fix loop for exactly one pattern (lint/format)
5. Expand fixable-pattern allowlist based on real failure data you collect from step 1–4
