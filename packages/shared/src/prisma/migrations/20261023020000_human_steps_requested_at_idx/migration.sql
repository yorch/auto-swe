-- CreateIndex
-- Plain CREATE INDEX: it takes a SHARE lock while it builds (reads proceed, writes wait).
-- workflow_human_steps holds a few rows per run, so the build is short. Backs the
-- approval-latency read in workflow analytics, which filters and orders on requested_at with
-- no status filter.
CREATE INDEX "workflow_human_steps_requested_at_idx" ON "workflow_human_steps"("requested_at");
