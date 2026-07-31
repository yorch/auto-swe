-- CI-wait strategy moves from env vars onto the WorkflowDefaults singleton,
-- matching how every other integration setting is configured.
--
-- All four columns are nullable on purpose: a NULL means "not configured in
-- the DB", so `resolveWorkflowDefaults` falls back to CI_WAIT_MODE /
-- CI_POLL_* and a deployment currently driving these from the environment
-- keeps working until an admin saves the form.
ALTER TABLE "workflow_defaults"
  ADD COLUMN "ci_wait_mode"         TEXT,
  ADD COLUMN "ci_poll_interval_sec" INTEGER,
  ADD COLUMN "ci_poll_grace_sec"    INTEGER,
  ADD COLUMN "ci_poll_deadline_sec" INTEGER;

-- Reject a typo at the database rather than silently degrading to 'signal'.
ALTER TABLE "workflow_defaults"
  ADD CONSTRAINT "workflow_defaults_ci_wait_mode_check"
  CHECK ("ci_wait_mode" IS NULL OR "ci_wait_mode" IN ('signal', 'poll'));

-- Poll cadence must be positive; a zero interval would busy-loop the CI poller.
ALTER TABLE "workflow_defaults"
  ADD CONSTRAINT "workflow_defaults_ci_poll_positive_check"
  CHECK (
    ("ci_poll_interval_sec" IS NULL OR "ci_poll_interval_sec" > 0)
    AND ("ci_poll_grace_sec"    IS NULL OR "ci_poll_grace_sec"    > 0)
    AND ("ci_poll_deadline_sec" IS NULL OR "ci_poll_deadline_sec" > 0)
  );
