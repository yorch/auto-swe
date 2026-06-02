-- ----------------------------------------------------------------------------
-- Index the `pull_requests` foreign keys. The table is queried by workflow and
-- by repo (CI/merge webhooks look up tracked PRs via repo + status, and PRs are
-- joined back to their ActiveWorkflow), but it shipped without any non-PK index.
-- These are plain B-tree indexes Prisma's DSL can express (@@index), kept in a
-- dedicated migration so it applies cleanly on top of the consolidated init.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "pull_requests_workflow_id_idx" ON "pull_requests"("workflow_id");
CREATE INDEX IF NOT EXISTS "pull_requests_repo_id_idx" ON "pull_requests"("repo_id");
