-- 021 ci_runs: 'skipped' status (SQLite no-op — folded into 017)
--
-- PostgreSQL altered the CHECK constraint via ALTER TABLE. SQLite cannot
-- alter a CHECK constraint, so the 'skipped' status is part of 017's schema
-- from the start. This migration is a documented no-op for migration-number
-- continuity (001–022 applied in order).
-- UP:
SELECT 1;
-- DOWN:
SELECT 1;