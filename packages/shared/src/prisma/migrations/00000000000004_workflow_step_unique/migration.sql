-- ----------------------------------------------------------------------------
-- WorkflowStep idempotency: a single (run, node, attempt) tuple is recorded
-- once. Temporal activities can retry, but retries must not duplicate step rows.
-- ----------------------------------------------------------------------------

ALTER TABLE "workflow_steps"
    ADD CONSTRAINT "workflow_steps_run_node_attempt_uidx"
        UNIQUE ("run_id", "node_id", "attempt");
