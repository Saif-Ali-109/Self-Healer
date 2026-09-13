# Contract: CI Run Comment (delivery & escalation)

**Branch**: `001-self-healer-ci-agent` | **Contract version**: 1.0 | **Plan**: [plan.md](../plan.md)

## Purpose

The outbound contract: how the agent communicates with humans. All findings are posted as **comments on the CI run** via the platform API (`gh api` wrapper pattern from Fleet's `github/gh.ts`). Comments are the only delivery channel in MVP (constitution principles I & V).

## Authorization

- Performed with a token from the `GH_TOKEN` environment variable (never committed, never logged — secrets rule).
- Comment write uses the platform's authenticated API; failures to post are escalated to the logs and SOR with the HTTP error, never silent.

## Comment types

### 1. Fix delivered (after verified fix)

```markdown
## 🤖 Self-Healer: fix proposed (auto-fix)

**Root cause**: [1–3 sentence human-readable summary with evidence]

**Pattern matched**: `lint/format`

**Branch**: `ci-fix/<run-id>`
**Diff summary**: [N files changed, +M/−K lines]
**Verification**: [affected check/test names], passed

> Review and merge at your discretion. The agent never merges.
```

### 2. Escalation (all trigger reasons)

```markdown
## 🤖 Self-Healer: needs a human (escalation)

**Reason**: [`low_confidence` | `fix_failed` | `multi_file` | `critical_branch` |
`budget_exhausted` | `no_pattern_match` | `infra` | `flaky_retries_exhausted`]

**Root cause**: [1–3 sentence summary with evidence]

**Suggested next step**: [actionable, one line]

**Evidence**: [links to logs/artifacts/prior attempts]
```

### 3. Flaky resolved (recovered after rerun)

```markdown
## 🤖 Self-Healer: flaky failure recovered

The failing job **passed on rerun N/3** for `#<run-id>` (commit `<sha>`).

No action needed.
```

## Delivery rules

- One comment per pipeline outcome (fix / escalation / flaky-resolved); fixed runs never also escalate.
- Comment content is assembled from persisted records (`fix_attempts` / `escalations`), so the comment is always reproducible from the audit trail.
- Secret material (tokens, keys) MUST never appear in comment bodies — the writer strips anything matching secret patterns and redacts (`***`) if it appears in logs/diffs.
- Comment posting failures are themselves logged + SOR-chained, satisfying "no silent decisions".

## Retention

Comments are external (platform-side). Local records keep `comment_url` for traceability.