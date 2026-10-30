ALTER TABLE "workflow_runs"
  ADD COLUMN "attributed_repo_id" UUID;

ALTER TABLE "workflow_run_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 4;

ALTER TABLE "human_step_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 4;

ALTER TABLE "review_verdict_daily_rollups"
  ALTER COLUMN "bucket_version" SET DEFAULT 4;

CREATE INDEX "workflow_runs_attributed_repo_id_started_at_idx"
  ON "workflow_runs"("attributed_repo_id", "started_at");

ALTER TABLE "workflow_runs"
  ADD CONSTRAINT "workflow_runs_attributed_repo_id_fkey"
  FOREIGN KEY ("attributed_repo_id") REFERENCES "connections"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

UPDATE "workflow_runs" AS target
SET "attributed_repo_id" = resolved."repo_id"
FROM (
  SELECT source."id", COALESCE(active_workflow."repo_id", source."connection_id") AS "repo_id"
  FROM "workflow_runs" AS source
  LEFT JOIN "active_workflows" AS active_workflow
    ON active_workflow."temporal_workflow_id" = source."workflow_id"
) AS resolved
WHERE target."id" = resolved."id"
  AND resolved."repo_id" IS NOT NULL;

ALTER TABLE "workflow_runs"
  VALIDATE CONSTRAINT "workflow_runs_attributed_repo_id_fkey";
