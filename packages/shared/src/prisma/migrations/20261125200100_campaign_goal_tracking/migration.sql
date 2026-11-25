-- CreateEnum
CREATE TYPE "CampaignPlan" AS ENUM ('UNIFORM', 'PLANNED');

-- CreateEnum
CREATE TYPE "CampaignGate" AS ENUM ('OPENED', 'MERGED');

-- CreateEnum
CREATE TYPE "CampaignScopeKind" AS ENUM ('TEAM', 'ORG');

-- CreateEnum
CREATE TYPE "CampaignWorkflowKind" AS ENUM ('LEGACY', 'RECONCILER');

-- CreateEnum
CREATE TYPE "CampaignAttemptOutcome" AS ENUM ('PR_OPENED', 'NO_CHANGE', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "budget_usd" DECIMAL(12,6),
ADD COLUMN     "expires_at" TIMESTAMPTZ,
ADD COLUMN     "gate" "CampaignGate" NOT NULL DEFAULT 'OPENED',
ADD COLUMN     "launched_by_id" UUID,
ADD COLUMN     "launcher_changed_at" TIMESTAMPTZ,
ADD COLUMN     "max_open_pull_requests" INTEGER,
ADD COLUMN     "paused_reason" TEXT,
ADD COLUMN     "plan" "CampaignPlan" NOT NULL DEFAULT 'UNIFORM',
ADD COLUMN     "rescan_interval_hours" INTEGER,
ADD COLUMN     "scope_id" UUID,
ADD COLUMN     "scope_kind" "CampaignScopeKind",
ADD COLUMN     "stale_after_days" INTEGER,
ADD COLUMN     "workflow_kind" "CampaignWorkflowKind" NOT NULL DEFAULT 'LEGACY';

-- AlterTable
ALTER TABLE "campaign_targets" ADD COLUMN     "brief" TEXT,
ADD COLUMN     "depends_on" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "last_checked_at" TIMESTAMPTZ,
ADD COLUMN     "last_checked_sha" TEXT,
ADD COLUMN     "regressions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stale_since" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "campaign_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "target_id" UUID NOT NULL,
    "n" INTEGER NOT NULL,
    "run_id" UUID,
    "child_workflow_id" TEXT,
    "path" "CampaignTargetPath",
    "verification" "CampaignVerification",
    "outcome" "CampaignAttemptOutcome",
    "failure_reason" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "campaign_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ,

    CONSTRAINT "campaign_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_attempts_child_workflow_id_key" ON "campaign_attempts"("child_workflow_id");

-- CreateIndex
CREATE INDEX "campaign_attempts_run_id_idx" ON "campaign_attempts"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_attempts_target_id_n_key" ON "campaign_attempts"("target_id", "n");

-- CreateIndex
CREATE INDEX "campaign_proposals_connection_id_idx" ON "campaign_proposals"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_proposals_campaign_id_connection_id_key" ON "campaign_proposals"("campaign_id", "connection_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_launched_by_id_fkey" FOREIGN KEY ("launched_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_attempts" ADD CONSTRAINT "campaign_attempts_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "campaign_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_attempts" ADD CONSTRAINT "campaign_attempts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_proposals" ADD CONSTRAINT "campaign_proposals_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_proposals" ADD CONSTRAINT "campaign_proposals_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill. Additive: no existing column is dropped, and the retired states stay in the enums.

-- The acting identity was the creator until now.
UPDATE "campaigns" SET "launched_by_id" = "created_by_id" WHERE "created_by_id" IS NOT NULL;

-- Every target that started a child becomes attempt 1. Runs before the state mapping below, which
-- rewrites the states this reads.
INSERT INTO "campaign_attempts" (
    "target_id", "n", "run_id", "child_workflow_id", "path", "verification", "outcome",
    "failure_reason", "started_at", "finished_at"
)
SELECT
    t."id",
    1,
    (SELECT r."id" FROM "workflow_runs" r WHERE r."workflow_id" = t."child_workflow_id"),
    t."child_workflow_id",
    t."path",
    t."verification",
    CASE t."state"
        WHEN 'PR_OPENED' THEN 'PR_OPENED'
        WHEN 'NOT_AFFECTED' THEN 'NO_CHANGE'
        WHEN 'FAILED' THEN 'FAILED'
        WHEN 'CANCELLED' THEN 'CANCELLED'
        ELSE NULL
    END::"CampaignAttemptOutcome",
    t."failure_reason",
    COALESCE(t."started_at", t."updated_at"),
    t."finished_at"
FROM "campaign_targets" t
WHERE t."child_workflow_id" IS NOT NULL;

-- NOT_AFFECTED is SATISFIED with initial evidence; FAILED needs a person. PR_OPENED stays. Only the
-- targets of a campaign already in a final state are remapped: a campaign still running on the
-- legacy workflow keeps the target values that workflow reads and writes.
UPDATE "campaign_targets"
SET "state" = 'SATISFIED',
    "evidence" = '{"kind":"initial"}'::jsonb,
    "last_checked_at" = COALESCE("finished_at", "updated_at")
WHERE "state" = 'NOT_AFFECTED'
  AND "campaign_id" IN (SELECT "id" FROM "campaigns" WHERE "state" IN ('COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'));

UPDATE "campaign_targets" SET "state" = 'NEEDS_ATTENTION'
WHERE "state" = 'FAILED'
  AND "campaign_id" IN (SELECT "id" FROM "campaigns" WHERE "state" IN ('COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'));

-- Hand-written: Prisma cannot express NOT NULL on a list column. Set after the backfill, so an
-- unset list cannot turn every dependency read into a null check.
ALTER TABLE "campaign_targets" ALTER COLUMN "depends_on" SET NOT NULL;
