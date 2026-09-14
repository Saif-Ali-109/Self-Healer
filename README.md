# Self-Healer CI Agent

> CI failure agent that classifies failures (flaky / real\_bug / infra), retries flaky, auto-fixes allowlisted bugs on a branch with a CI comment, never auto-PRs or merges, and logs every decision in a tamper-evident audit trail.

## Quick start

```bash
cp .env.example .env           # fill in secrets
npm install
npm run migrate:up             # apply Fleet 001–016 + Self-Healer 017–020
npm run start                  # webhook listener + single worker daemon
```

Webhook endpoint: `POST /api/webhook/ci`

## Development

```bash
npm run typecheck
npm test
npm run lint
npm run format
```

## Architecture

See `specs/001-self-healer-ci-agent/plan.md` for full technical design.
