-- 019 fix_attempts: automated fix attempts for CI runs (SQLite)
-- UP:
CREATE TABLE fix_attempts (
  attempt_id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id              TEXT NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE UNIQUE,
  pattern_matched     TEXT NOT NULL,
  diff                TEXT NOT NULL,
  branch              TEXT NOT NULL,
  verification_result TEXT NOT NULL CHECK (verification_result IN ('passed','failed')),
  test_summary        TEXT,
  comment_url         TEXT,
  created_at          INTEGER NOT NULL
);
-- DOWN:
DROP TABLE IF EXISTS fix_attempts;