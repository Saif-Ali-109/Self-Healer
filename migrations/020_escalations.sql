-- 020 escalations: escalation records when auto-fix cannot proceed
-- UP:
CREATE TABLE escalations (
  escalation_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE UNIQUE,
  reason              TEXT NOT NULL CHECK (reason IN ('low_confidence','fix_failed','multi_file','critical_branch','budget_exhausted','no_pattern_match','infra','flaky_retries_exhausted','checkout_failed')),
  summary             TEXT NOT NULL,
  suggested_next_step TEXT NOT NULL,
  comment_url         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- DOWN:
DROP TABLE IF EXISTS escalations CASCADE;
