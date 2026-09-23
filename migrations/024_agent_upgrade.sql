-- 024 agent upgrade (SQLite)
--  * ci_runs: lineage columns for the re-fix loop (parent run, cycle, fix branch)
--  * escalations: drop the reason CHECK (SQLite cannot ALTER a CHECK) so new
--    reasons (retry_cap_exceeded, agent_gave_up, llm_unavailable, ...) are allowed;
--    the allowed set is enforced in TypeScript (EscalationReason).
--  * repo_notes: persistent, per-repo learning notes the agent reads before
--    deciding and writes after each run.
-- UP:
ALTER TABLE ci_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE ci_runs ADD COLUMN fix_cycle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ci_runs ADD COLUMN fix_branch TEXT;
CREATE INDEX idx_ci_runs_fix_branch ON ci_runs (repo, fix_branch);

-- fix_attempts: what the agent believed and did (used as context for re-fix cycles)
ALTER TABLE fix_attempts ADD COLUMN root_cause TEXT;
ALTER TABLE fix_attempts ADD COLUMN summary TEXT;
ALTER TABLE fix_attempts ADD COLUMN files_changed TEXT;
ALTER TABLE fix_attempts ADD COLUMN model TEXT;

CREATE TABLE escalations_new (
  escalation_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id              TEXT NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE UNIQUE,
  reason              TEXT NOT NULL,
  summary             TEXT NOT NULL,
  suggested_next_step TEXT NOT NULL,
  comment_url         TEXT,
  created_at          INTEGER NOT NULL
);
INSERT INTO escalations_new SELECT escalation_id, run_id, reason, summary, suggested_next_step, comment_url, created_at FROM escalations;
DROP TABLE escalations;
ALTER TABLE escalations_new RENAME TO escalations;

CREATE TABLE repo_notes (
  note_id        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  repo           TEXT NOT NULL,
  kind           TEXT NOT NULL,                -- flaky_hint | root_cause | fix_recipe | gotcha | avoid | test_info | run_outcome
  body           TEXT NOT NULL,                -- one short, self-contained takeaway
  tags           TEXT NOT NULL DEFAULT '',     -- space-separated lowercase keywords
  files          TEXT NOT NULL DEFAULT '',     -- space-separated repo-relative paths the note is about
  source_run_id  TEXT,                         -- run that produced the note (no FK: notes outlive runs)
  source         TEXT NOT NULL DEFAULT 'agent',-- agent | system | human
  confidence     REAL NOT NULL DEFAULT 0.6,    -- 0..1, decays if a fix built on it fails
  reinforced     INTEGER NOT NULL DEFAULT 0,   -- times the same takeaway was seen again
  times_used     INTEGER NOT NULL DEFAULT 0,   -- times injected into a prompt
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);
CREATE INDEX idx_repo_notes_repo ON repo_notes (repo, status);
-- DOWN:
DROP TABLE IF EXISTS repo_notes;
ALTER TABLE fix_attempts DROP COLUMN model;
ALTER TABLE fix_attempts DROP COLUMN files_changed;
ALTER TABLE fix_attempts DROP COLUMN summary;
ALTER TABLE fix_attempts DROP COLUMN root_cause;
DROP INDEX IF EXISTS idx_ci_runs_fix_branch;
ALTER TABLE ci_runs DROP COLUMN fix_branch;
ALTER TABLE ci_runs DROP COLUMN fix_cycle;
ALTER TABLE ci_runs DROP COLUMN parent_run_id;
DELETE FROM escalations WHERE reason NOT IN ('low_confidence','fix_failed','multi_file','critical_branch','budget_exhausted','no_pattern_match','infra','flaky_retries_exhausted','checkout_failed');
CREATE TABLE escalations_old (
  escalation_id       TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id              TEXT NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE UNIQUE,
  reason              TEXT NOT NULL CHECK (reason IN ('low_confidence','fix_failed','multi_file','critical_branch','budget_exhausted','no_pattern_match','infra','flaky_retries_exhausted','checkout_failed')),
  summary             TEXT NOT NULL,
  suggested_next_step TEXT NOT NULL,
  comment_url         TEXT,
  created_at          INTEGER NOT NULL
);
INSERT INTO escalations_old SELECT escalation_id, run_id, reason, summary, suggested_next_step, comment_url, created_at FROM escalations;
DROP TABLE escalations;
ALTER TABLE escalations_old RENAME TO escalations;
