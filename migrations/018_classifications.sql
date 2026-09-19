-- 018 classifications: classification results for CI runs (SQLite)
-- UP:
CREATE TABLE classifications (
  classification_id  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  run_id             TEXT NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE,
  category           TEXT NOT NULL CHECK (category IN ('flaky','real_bug','infra')),
  confidence         REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence           TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  model              TEXT,
  summary            TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_classifications_run ON classifications (run_id);
CREATE INDEX idx_classifications_category ON classifications (category, created_at);
-- DOWN:
DROP TABLE IF EXISTS classifications;