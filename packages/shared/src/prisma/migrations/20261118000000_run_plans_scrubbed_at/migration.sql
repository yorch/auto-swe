-- A launched plan keeps its goal and plan body only for `runPlans.launchedRetentionDays`; after
-- that the sweep scrubs the text and stamps `scrubbed_at`. The row stays: a run's `triggerRefId`
-- is the plan id. Additive and hand-written like its neighbours; `IF NOT EXISTS` keeps a re-apply
-- harmless. The CHECK and the partial index are invisible to the schema diff.
ALTER TABLE "run_plans" ADD COLUMN IF NOT EXISTS "scrubbed_at" TIMESTAMPTZ;

-- Only a launched plan is ever scrubbed; every other state is deleted or expires, never scrubbed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'run_plans_scrubbed_launched_check'
  ) THEN
    ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_scrubbed_launched_check"
      CHECK ("scrubbed_at" IS NULL OR "status" = 'LAUNCHED');
  END IF;
END $$;

-- The sweep's candidate read: launched, not yet scrubbed, oldest approval first, per team.
CREATE INDEX IF NOT EXISTS "run_plans_launched_unscrubbed_idx"
  ON "run_plans"("team_id", "approved_at")
  WHERE "scrubbed_at" IS NULL AND "status" = 'LAUNCHED';
