# Contract: Classification Result

**Branch**: `001-self-healer-ci-agent` | **Contract version**: 1.0 | **Plan**: [plan.md](../plan.md)

## Purpose

The contract between the classifier role and the rest of the pipeline: the decision record that gates retry vs. fix vs. escalation. Rule-first, evidence-backed, confidence-scored (constitution principle II).

## Output shape

```jsonc
{
  "run_id": "uuid",
  "category": "flaky",            // 'flaky' | 'real_bug' | 'infra'
  "confidence": 0.9,              // 0.00–1.00
  "evidence": [                   // non-empty — what drove the decision
    {"signal": "passed_on_previous_run", "detail": "run 12346 same commit passed"},
    {"signal": "timing_pattern", "detail": "test timed out at 30s, avg 45s"}
  ],
  "classifier_version": "signals-v1",
  "model": "gemini-2.5-flash",    // optional — only when LLM enriched the summary
  "summary": "…human-readable root cause…", // required for real_bug (LLM or template)
  "decided_at": "2026-09-13T12:01:00Z"
}
```

## Categorization rules (deterministic, rule-first)

| Signal | Category contribution |
|---|---|
| Test passed on a previous run of same commit/branch | → `flaky` (strong) |
| Known flaky history (prior `flaky` classification for same test/job) | → `flaky` |
| Timing/race pattern: timeout, connection reset, non-deterministic order | → `flaky` |
| Rate limit / disk full / Docker pull failure / expired credentials | → `infra` |
| No flaky or infra signal | → `real_bug` |

## Confidence

- Strong signal match (exact pattern): `0.9`
- One moderate signal: `0.75`
- Conflicting signals (e.g., infra pattern present on a job without infra access): `0.5`
- Rule: **confidence ≥ 0.7 → proceed to fix path; < 0.7 → escalate** (constitution Delivery). `real_bug` classifications are the only ones that enter the fix-scope guardrail.

## Error handling

- No logs available: best-effort signal match from headers/metadata; missing evidence is recorded in `evidence` as `{"signal":"log_unavailable"}` and confidence capped at `0.5` → escalates (never fixes blind).
- Infra is stubbed in MVP: any infra signal → immediate escalation with `reason: 'infra'`.

## Compliance

Every classification is persisted to `classifications` AND chained through Fleet's SOR ingest (constitution principle IV) — no silent decisions.