# Contract: CI Failure Webhook (GitHub Actions adapter)

**Branch**: `001-self-healer-ci-agent` | **Contract version**: 1.0 | **Plan**: [plan.md](../plan.md)

## Purpose

Defines the inbound contract: how a CI system notifies the agent of a failed run, and the canonical normalized event the adapter must produce. The agent is CI-agnostic (constitution principle I) — the adapter converts platform payloads into the canonical shape below.

## Transport

- Method: `POST`
- Path: `/api/webhook/ci` (standalone `node:http` server on `CI_WEBHOOK_PORT`)
- Content-Type: `application/json`
- Max payload: 256 KB
- Auth: `X-Webhook-Secret` header, HMAC-verified with the value of the `CI_WEBHOOK_SECRET` environment variable (secrets never appear in logs or records — constitution §Secrets).

## Canonical normalized event (adapter output — the contract everything downstream consumes)

```jsonc
{
  "repo": "owner/name",            // required
  "commit": "full-40-char-sha",    // required
  "branch": "feature/x",           // required
  "external_run_id": "1234567890", // required — CI platform run id
  "job_id": "987654321",           // required
  "job_name": "test (ubuntu-latest)", // required
  "status": "failed",              // required — 'failed' is the only intake status
  "log_url": "https://api.github.com/repos/o/n/actions/jobs/987654321/logs", // required
  "artifact_url": "https://...",   // optional
  "delivered_at": "2026-09-13T12:00:00Z" // required
}
```

## GitHub Actions adapter mapping (v1 — the only adapter in MVP)

The adapter receives the GitHub Actions webhook JSON and maps it as follows; anything unmappable is rejected with `400` and a logged reason (never silently dropped).

| GitHub Actions field | Canonical field | Notes |
|---|---|---|
| `workflow_job.workflow_name` (context) | — | info only |
| `repository.full_name` | `repo` | |
| `workflow_job.head_sha` | `commit` | |
| `workflow_job.head_branch` | `branch` | |
| `workflow_run.id` | `external_run_id` | |
| `workflow_job.id` | `job_id` | |
| `workflow_job.name` | `job_name` | |
| `workflow_job.conclusion` | `status` | only `failure` is ingested |
| `workflow_job.check_run_url` | `log_url` | |
| header `X-GitHub-Event` | — | must be `workflow_job` (or `check_run`) |

## Response codes

| Code | Meaning |
|---|---|
| `202 Accepted` | Event accepted and enqueued for processing |
| `400 Bad Request` | Malformed payload, unknown event type, or `status != failed` |
| `401 Unauthorized` | Missing/invalid `X-Webhook-Secret` |
| `409 Conflict` | Duplicate event already enqueued (same `external_run_id` + `repo` + `job_id`) |

## Error handling

- Logs/artifacts unavailable → still enqueue with whatever is present; classifier proceeds best-effort and records what was missing (spec Edge Cases).
- Unknown CI vendor → `400` with reason; logged; never guessed.