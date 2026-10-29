-- CreateTable
CREATE TABLE "workflow_run_daily_rollups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "dimension_key" TEXT NOT NULL,
    "org_id" UUID,
    "team_id" UUID,
    "template_id" UUID,
    "template_version" INTEGER,
    "repo_id" UUID,
    "status" TEXT NOT NULL,
    "outcome_domain" TEXT,
    "outcome_type" TEXT,
    "was_autonomous" BOOLEAN,
    "had_human_step" BOOLEAN,
    "runs" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "time_saved_minutes" DOUBLE PRECISION NOT NULL,
    "duration_ms_sum" BIGINT NOT NULL,
    "duration_count" INTEGER NOT NULL,
    "duration_buckets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "runs_with_pr" INTEGER NOT NULL,
    "prs_opened" INTEGER NOT NULL,
    "prs_merged" INTEGER NOT NULL,
    "prs_closed_unmerged" INTEGER NOT NULL,
    "prs_ci_passed" INTEGER NOT NULL,
    "merge_ms_buckets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "ci_fix_attempts" INTEGER NOT NULL,
    "runs_with_ci_fix" INTEGER NOT NULL,
    "ci_fix_rounds_buckets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "runs_ci_healed" INTEGER NOT NULL,
    "runs_review_rejected" INTEGER NOT NULL,
    "runs_review_rejected_with_pr" INTEGER NOT NULL,
    "runs_review_rejected_merged" INTEGER NOT NULL,
    "runs_with_pr_merged" INTEGER NOT NULL,
    "built_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_run_daily_rollups_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workflow_run_daily_rollups"
  ALTER COLUMN "duration_buckets" SET NOT NULL,
  ALTER COLUMN "merge_ms_buckets" SET NOT NULL,
  ALTER COLUMN "ci_fix_rounds_buckets" SET NOT NULL;

-- CreateIndex
CREATE INDEX "workflow_run_daily_rollups_day_idx" ON "workflow_run_daily_rollups"("day");

-- CreateIndex
CREATE INDEX "workflow_run_daily_rollups_org_id_day_idx" ON "workflow_run_daily_rollups"("org_id", "day");

-- CreateIndex
CREATE INDEX "workflow_run_daily_rollups_team_id_day_idx" ON "workflow_run_daily_rollups"("team_id", "day");

-- CreateIndex
CREATE INDEX "workflow_run_daily_rollups_template_id_day_idx" ON "workflow_run_daily_rollups"("template_id", "day");

CREATE UNIQUE INDEX "workflow_run_daily_rollups_day_dimension_key_key"
  ON "workflow_run_daily_rollups"("day", "dimension_key");
