-- 017 ci_runs: CI run tracking table + SOR audit chain (SQLite)
-- UP:
CREATE TABLE ci_runs (
  run_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  external_run_id TEXT NOT NULL,
  repo            TEXT NOT NULL,
  "commit"        TEXT NOT NULL,
  branch          TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  job_name        TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved','skipped')),
  log_url         TEXT,
  artifact_url    TEXT,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

CREATE UNIQUE INDEX uq_ci_runs_extrn ON ci_runs (external_run_id, repo, job_id);
CREATE INDEX idx_ci_runs_commit ON ci_runs (repo, "commit");
CREATE INDEX idx_ci_runs_branch ON ci_runs (branch);

-- SOR audit chain: append-only tamper-evident log (hash chain stored here).
CREATE TABLE sor_chain (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  seq    INTEGER NOT NULL DEFAULT 0,
  hash   TEXT NOT NULL,
  key_id TEXT NOT NULL
);

CREATE TABLE audit_events (
  event_id    TEXT PRIMARY KEY,
  run_id      TEXT,
  seq         INTEGER NOT NULL UNIQUE,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  backend     TEXT,
  tool_name   TEXT,
  tool_input  TEXT,
  tool_output TEXT,
  payload     TEXT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_audit_events_run ON audit_events (run_id);
-- DOWN:
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS sor_chain;
DROP TABLE IF EXISTS ci_runs;