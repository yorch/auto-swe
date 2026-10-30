DELETE FROM "workflow_run_daily_rollups";

ALTER TABLE "workflow_run_daily_rollups"
ADD COLUMN "bucket_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "rollup_sweep_states" (
    "name" TEXT NOT NULL,
    "last_successful_start_at" TIMESTAMPTZ,

    CONSTRAINT "rollup_sweep_states_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "workflow_runs_ended_at_started_at_idx"
ON "workflow_runs"("ended_at", "started_at");

CREATE INDEX "pull_requests_merged_at_run_id_idx"
ON "pull_requests"("merged_at", "run_id");

CREATE INDEX "pull_requests_closed_at_run_id_idx"
ON "pull_requests"("closed_at", "run_id");

CREATE INDEX "workflow_human_steps_resolved_at_run_id_idx"
ON "workflow_human_steps"("resolved_at", "run_id");
