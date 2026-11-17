-- A run's plan is found by the run it launched (`launched_workflow_run_id`), and deleting a run
-- sets that column NULL through its foreign key: without an index each delete scans run_plans.
-- Additive and hand-written like its neighbours; `IF NOT EXISTS` keeps a re-apply harmless.
CREATE INDEX IF NOT EXISTS "run_plans_launched_workflow_run_id_idx" ON "run_plans"("launched_workflow_run_id");
