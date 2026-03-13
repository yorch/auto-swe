-- AlterTable
ALTER TABLE "active_workflows"
  ADD COLUMN "budget_tier" TEXT NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "tokens_input_used" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tokens_output_used" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cost_usd_accrued" DOUBLE PRECISION NOT NULL DEFAULT 0;
