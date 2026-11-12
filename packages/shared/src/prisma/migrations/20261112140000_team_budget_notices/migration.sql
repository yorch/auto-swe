CREATE TABLE "team_budget_notices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_budget_notices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_budget_notices_team_id_period_level_key" ON "team_budget_notices"("team_id", "period", "level");

ALTER TABLE "team_budget_notices" ADD CONSTRAINT "team_budget_notices_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
