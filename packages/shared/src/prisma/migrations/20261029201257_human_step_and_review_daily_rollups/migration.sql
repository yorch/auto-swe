CREATE TABLE "human_step_daily_rollups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "bucket_version" INTEGER NOT NULL DEFAULT 2,
    "dimension_key" TEXT NOT NULL,
    "org_id" UUID,
    "team_id" UUID,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resolved_via" TEXT NOT NULL,
    "resolved_by" UUID,
    "steps" INTEGER NOT NULL,
    "wait_ms_sum" BIGINT NOT NULL,
    "wait_buckets" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "timed_out" INTEGER NOT NULL,
    "built_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_step_daily_rollups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "human_step_daily_rollups_day_dimension_key_key"
  ON "human_step_daily_rollups"("day", "dimension_key");
CREATE INDEX "human_step_daily_rollups_day_idx"
  ON "human_step_daily_rollups"("day");
CREATE INDEX "human_step_daily_rollups_org_id_day_idx"
  ON "human_step_daily_rollups"("org_id", "day");
CREATE INDEX "human_step_daily_rollups_team_id_day_idx"
  ON "human_step_daily_rollups"("team_id", "day");

CREATE TABLE "review_verdict_daily_rollups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "bucket_version" INTEGER NOT NULL DEFAULT 2,
    "dimension_key" TEXT NOT NULL,
    "org_id" UUID,
    "team_id" UUID,
    "reviewer" TEXT,
    "severity" TEXT,
    "approved" BOOLEAN,
    "verdicts" INTEGER NOT NULL,
    "findings" INTEGER NOT NULL,
    "category_counts" JSONB NOT NULL DEFAULT '{}',
    "non_verdict_rows" INTEGER NOT NULL,
    "built_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_verdict_daily_rollups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_verdict_daily_rollups_day_dimension_key_key"
  ON "review_verdict_daily_rollups"("day", "dimension_key");
CREATE INDEX "review_verdict_daily_rollups_day_idx"
  ON "review_verdict_daily_rollups"("day");
CREATE INDEX "review_verdict_daily_rollups_org_id_day_idx"
  ON "review_verdict_daily_rollups"("org_id", "day");
CREATE INDEX "review_verdict_daily_rollups_team_id_day_idx"
  ON "review_verdict_daily_rollups"("team_id", "day");
