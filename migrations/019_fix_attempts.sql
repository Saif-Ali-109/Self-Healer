-- 019 fix_attempts: automated fix attempts for CI runs
-- UP:
CREATE TABLE fix_attempts (
  attempt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE UNIQUE,
  pattern_matched     TEXT NOT NULL,
  diff                TEXT NOT NULL,
  branch              TEXT NOT NULL,
  verification_result TEXT NOT NULL CHECK (verification_result IN ('passed','failed')),
  test_summary        TEXT,
  comment_url         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- DOWN:
DROP TABLE IF EXISTS fix_attempts CASCADE;
