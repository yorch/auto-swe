-- ----------------------------------------------------------------------------
-- WorkflowStep idempotency: a single (run, node, attempt) tuple is recorded
-- once. Temporal activities can retry, but retries must not duplicate step rows.
--
-- The unique index is created first so the constraint addition is idempotent.
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_run_node_attempt_uidx"
    ON "workflow_steps" ("run_id", "node_id", "attempt");

ALTER TABLE "workflow_steps"
    ADD CONSTRAINT IF NOT EXISTS "workflow_steps_run_node_attempt_uidx"
        UNIQUE USING INDEX "workflow_steps_run_node_attempt_uidx";
