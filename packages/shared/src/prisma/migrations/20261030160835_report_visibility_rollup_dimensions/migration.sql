ALTER TABLE "workflow_run_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 3,
  ADD COLUMN "launched_by_id" UUID;

ALTER TABLE "human_step_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 3,
  ADD COLUMN "repo_id" UUID,
  ADD COLUMN "launched_by_id" UUID;

ALTER TABLE "review_verdict_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 3,
  ADD COLUMN "repo_id" UUID,
  ADD COLUMN "launched_by_id" UUID;

CREATE INDEX "workflow_run_daily_rollups_repo_id_day_idx"
  ON "workflow_run_daily_rollups"("repo_id", "day");
CREATE INDEX "workflow_run_daily_rollups_launched_by_id_day_idx"
  ON "workflow_run_daily_rollups"("launched_by_id", "day");
CREATE INDEX "human_step_daily_rollups_repo_id_day_idx"
  ON "human_step_daily_rollups"("repo_id", "day");
CREATE INDEX "human_step_daily_rollups_launched_by_id_day_idx"
  ON "human_step_daily_rollups"("launched_by_id", "day");
CREATE INDEX "review_verdict_daily_rollups_repo_id_day_idx"
  ON "review_verdict_daily_rollups"("repo_id", "day");
CREATE INDEX "review_verdict_daily_rollups_launched_by_id_day_idx"
  ON "review_verdict_daily_rollups"("launched_by_id", "day");
