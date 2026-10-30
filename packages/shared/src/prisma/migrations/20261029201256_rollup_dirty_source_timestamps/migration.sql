ALTER TABLE "workflow_runs"
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "pull_requests"
  ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "rollup_sweep_states"
  ADD COLUMN "pending_dirty_days" DATE[] NOT NULL DEFAULT ARRAY[]::DATE[];

INSERT INTO "rollup_sweep_states"("name", "last_successful_start_at", "pending_dirty_days")
VALUES ('workflow_run_daily', CURRENT_TIMESTAMP, ARRAY[]::DATE[])
ON CONFLICT ("name") DO UPDATE
SET "last_successful_start_at" = COALESCE(
  "rollup_sweep_states"."last_successful_start_at",
  EXCLUDED."last_successful_start_at"
);

CREATE INDEX "workflow_runs_updated_at_started_at_idx"
  ON "workflow_runs"("updated_at", "started_at");
CREATE INDEX "pull_requests_updated_at_run_id_idx"
  ON "pull_requests"("updated_at", "run_id");
CREATE INDEX "workflow_steps_ended_at_run_id_idx"
  ON "workflow_steps"("ended_at", "run_id");
CREATE INDEX "agent_traces_created_at_run_id_idx"
  ON "agent_traces"("created_at", "run_id");
