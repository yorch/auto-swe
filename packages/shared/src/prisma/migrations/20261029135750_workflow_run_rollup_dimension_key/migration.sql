ALTER TABLE "workflow_run_daily_rollups"
  ADD COLUMN "dimension_key" TEXT;

UPDATE "workflow_run_daily_rollups"
SET "dimension_key" = jsonb_build_array(
  "org_id",
  "team_id",
  "template_id",
  "template_version",
  "repo_id",
  "status",
  "outcome_domain",
  "outcome_type",
  "was_autonomous",
  "had_human_step"
)::text;

ALTER TABLE "workflow_run_daily_rollups"
  ALTER COLUMN "dimension_key" SET NOT NULL;

CREATE UNIQUE INDEX "workflow_run_daily_rollups_day_dimension_key_key"
  ON "workflow_run_daily_rollups"("day", "dimension_key");
