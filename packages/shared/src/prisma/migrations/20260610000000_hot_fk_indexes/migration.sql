-- ARCH-6: indexes on hot foreign-key columns.
-- active_workflows is joined through on every /runs visibility check and
-- resolved by (repo_id, assigned_branch) in the fix-session fallback path;
-- agent_lessons is filtered by (repo_id, consolidated_at) on every retrieval
-- and consolidation query (only the HNSW embedding index existed before).

CREATE INDEX "active_workflows_work_request_id_idx" ON "active_workflows"("work_request_id");

CREATE INDEX "active_workflows_repo_id_assigned_branch_idx" ON "active_workflows"("repo_id", "assigned_branch");

CREATE INDEX "agent_lessons_repo_id_consolidated_at_idx" ON "agent_lessons"("repo_id", "consolidated_at");
