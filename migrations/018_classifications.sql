-- 018 classifications: classification results for CI runs
-- UP:
CREATE TABLE classifications (
  classification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES ci_runs(run_id) ON DELETE CASCADE,
  category           TEXT NOT NULL CHECK (category IN ('flaky','real_bug','infra')),
  confidence         NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence           JSONB NOT NULL,
  classifier_version TEXT NOT NULL,
  model              TEXT,
  summary            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_classifications_run ON classifications (run_id);
CREATE INDEX idx_classifications_category ON classifications (category, created_at);
-- DOWN:
DROP TABLE IF EXISTS classifications CASCADE;
