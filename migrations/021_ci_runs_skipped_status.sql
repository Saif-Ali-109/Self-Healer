-- 021 ci_runs: allow 'skipped' status for deduplicated re-fired events
--
-- The reporter workflow re-fires on every workflow-run completion during rerun
-- cycles (same run id, same job name, new job id). Those re-fires are dropped
-- at enqueue time by the per-(external_run_id, repo, job_name) dedup, and any
-- rows that were already queued before the dedup existed are drained to
-- 'skipped' by the worker instead of being re-processed.
-- UP:
ALTER TABLE ci_runs DROP CONSTRAINT ci_runs_status_check;
ALTER TABLE ci_runs ADD CONSTRAINT ci_runs_status_check CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved','skipped'));
-- DOWN:
ALTER TABLE ci_runs DROP CONSTRAINT ci_runs_status_check;
ALTER TABLE ci_runs ADD CONSTRAINT ci_runs_status_check CHECK (status IN ('pending','classifying','retrying','fixing','escalated','resolved'));