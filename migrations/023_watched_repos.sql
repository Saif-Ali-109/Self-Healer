-- 023 watched_repos: repos opted in via `self-healer enable --repo owner/repo` (US6)
-- The enable command writes self-healer-notify.yml (opening a PR a human merges)
-- and records the repo here so `status` can list watched repos.
-- UP:
CREATE TABLE watched_repos (
  repo            TEXT PRIMARY KEY,
  added_at        INTEGER NOT NULL,
  workflow_branch TEXT NOT NULL,
  workflow_pr     TEXT
);
-- DOWN:
DROP TABLE IF EXISTS watched_repos;