-- CreateTable
CREATE TABLE "rollup_built_days" (
    "day" DATE NOT NULL,
    "bucket_version" INTEGER NOT NULL,
    "built_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rollup_built_days_pkey" PRIMARY KEY ("day","bucket_version")
);

-- Runs after the migration that deletes rollup rows older than the current bucket version, so only
-- days already rebuilt at the current version are marked; every other day is marked when the sweep
-- rebuilds it.
-- Days that already hold rollup rows were built by an earlier sweep. A built day with no runs
-- left no row, so it is marked by the next sweep (backfill or recompute window), not here.
INSERT INTO "rollup_built_days" ("day", "bucket_version")
SELECT DISTINCT "day", "bucket_version" FROM "workflow_run_daily_rollups"
ON CONFLICT DO NOTHING;
