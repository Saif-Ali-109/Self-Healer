-- 017 ci_runs: CI run tracking table
-- UP:
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE ci_runs (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_run_id TEXT NOT NULL,
  repo            TEXT NOT NULL,
  commit          TEXT NOT NULL,
  branch          TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  job_name        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved')),
  log_url         TEXT,
  artifact_url    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_ci_runs_extrn ON ci_runs (external_run_id, repo, job_id);
CREATE INDEX idx_ci_runs_commit ON ci_runs (repo, commit);
CREATE INDEX idx_ci_runs_branch ON ci_runs (branch);
-- DOWN:
DROP TABLE IF EXISTS ci_runs CASCADE;
