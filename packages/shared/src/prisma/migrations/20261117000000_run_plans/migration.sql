-- CreateEnum
CREATE TYPE "RunPlanStatus" AS ENUM ('PENDING', 'APPROVED', 'LAUNCHED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "run_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "agent_key" TEXT,
    "intent" TEXT NOT NULL,
    "router_candidates" JSONB NOT NULL,
    "spec" JSONB NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "skeleton_report" JSONB NOT NULL,
    "validation_report" JSONB NOT NULL,
    "cost_estimate" JSONB NOT NULL,
    "catalog_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "agent_pins" JSONB NOT NULL,
    "settings_snapshot" JSONB NOT NULL,
    "mode" TEXT NOT NULL,
    "status" "RunPlanStatus" NOT NULL DEFAULT 'PENDING',
    "approved_at" TIMESTAMPTZ,
    "approved_by_id" UUID,
    "launched_workflow_run_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "run_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_plans_owner_user_id_status_idx" ON "run_plans"("owner_user_id", "status");

-- CreateIndex
CREATE INDEX "run_plans_status_expires_at_idx" ON "run_plans"("status", "expires_at");

-- CreateIndex
CREATE INDEX "run_plans_team_id_idx" ON "run_plans"("team_id");

-- CreateIndex
CREATE INDEX "run_plans_connection_id_idx" ON "run_plans"("connection_id");

-- AddForeignKey
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_launched_workflow_run_id_fkey" FOREIGN KEY ("launched_workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written DDL (Prisma's DSL cannot express CHECK constraints). These are invisible to the
-- schema diff, so `prisma migrate diff` neither proposes nor drops them.

-- A plan always has a human owner: the person who asked for it and the only one who may approve it.
-- NOT NULL already says so; the named constraint keeps a later "make it nullable for service
-- principals" change from passing review as a plain column edit.
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_owner_present_check"
  CHECK ("owner_user_id" IS NOT NULL);

ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_mode_check"
  CHECK ("mode" IN ('delivering', 'output-only'));

ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- A state past PENDING (other than a rejection or an expiry) was approved by someone at some time.
-- `approved_by_id` is deliberately not in the check: it is SET NULL when the approver is deleted.
ALTER TABLE "run_plans" ADD CONSTRAINT "run_plans_approved_state_check"
  CHECK ("status" NOT IN ('APPROVED', 'LAUNCHED') OR "approved_at" IS NOT NULL);
