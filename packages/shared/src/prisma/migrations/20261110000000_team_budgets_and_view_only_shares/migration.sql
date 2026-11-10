-- Per-team monthly budget (beside the organization's) and view-only repository shares.
-- Additive only: nullable columns and a defaulted boolean, so a running deployment keeps working
-- and every existing share keeps launching (can_launch defaults to true).
-- AlterTable
ALTER TABLE "connection_team_shares" ADD COLUMN     "can_launch" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "budget_alert_threshold_percent" INTEGER,
ADD COLUMN     "monthly_budget_usd_cents" INTEGER;

-- The team a connection-less launch was held to (RunInput.billingTeamId), the last source of a
-- run's attributed team. Null on every existing row.
-- AlterTable
ALTER TABLE "run_inputs" ADD COLUMN     "billing_team_id" UUID;

-- CreateIndex
CREATE INDEX "run_inputs_billing_team_id_idx" ON "run_inputs"("billing_team_id");

-- Serves the team spend read: finalized runs of an attributed team ended this month.
-- CreateIndex
CREATE INDEX "workflow_runs_attributed_team_id_ended_at_idx" ON "workflow_runs"("attributed_team_id", "ended_at");

-- AddForeignKey
ALTER TABLE "run_inputs" ADD CONSTRAINT "run_inputs_billing_team_id_fkey" FOREIGN KEY ("billing_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
