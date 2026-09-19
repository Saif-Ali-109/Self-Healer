-- 022 fix_pr_url: fix PR delivery (constitution v1.2.0 — human-approved delivery)
-- UP:
ALTER TABLE fix_attempts ADD COLUMN fix_pr_url TEXT;
-- DOWN:
ALTER TABLE fix_attempts DROP COLUMN fix_pr_url;