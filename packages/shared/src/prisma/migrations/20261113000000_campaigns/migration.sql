-- CreateEnum
CREATE TYPE "CampaignState" AS ENUM ('STARTING', 'RUNNING', 'CANCELLING', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START');

-- CreateEnum
CREATE TYPE "CampaignTargetState" AS ENUM ('PENDING', 'RUNNING', 'PR_OPENED', 'NOT_AFFECTED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignTargetPath" AS ENUM ('RECIPE', 'AGENT', 'RECIPE_THEN_AGENT', 'NONE');

-- CreateEnum
CREATE TYPE "CampaignVerification" AS ENUM ('PASSED', 'FAILED', 'NOT_RUN');

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "owner_team_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "recipe_ref" TEXT,
    "recipe_params" JSONB,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "max_parallel" INTEGER NOT NULL,
    "state" "CampaignState" NOT NULL DEFAULT 'STARTING',
    "temporal_workflow_id" TEXT NOT NULL,
    "work_request_id" UUID NOT NULL,
    "created_by_id" UUID,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "connection_id" UUID,
    "team_id" UUID NOT NULL,
    "repo_label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "state" "CampaignTargetState" NOT NULL DEFAULT 'PENDING',
    "path" "CampaignTargetPath",
    "verification" "CampaignVerification",
    "child_workflow_id" TEXT,
    "pr_url" TEXT,
    "pr_number" INTEGER,
    "failure_reason" TEXT,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_temporal_workflow_id_key" ON "campaigns"("temporal_workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_work_request_id_key" ON "campaigns"("work_request_id");

-- CreateIndex
CREATE INDEX "campaigns_owner_team_id_created_at_idx" ON "campaigns"("owner_team_id", "created_at");

-- CreateIndex
CREATE INDEX "campaigns_org_id_created_at_idx" ON "campaigns"("org_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_targets_child_workflow_id_key" ON "campaign_targets"("child_workflow_id");

-- CreateIndex
CREATE INDEX "campaign_targets_team_id_idx" ON "campaign_targets"("team_id");

-- CreateIndex
CREATE INDEX "campaign_targets_connection_id_idx" ON "campaign_targets"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_targets_campaign_id_connection_id_key" ON "campaign_targets"("campaign_id", "connection_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_team_id_fkey" FOREIGN KEY ("owner_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "run_inputs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targets" ADD CONSTRAINT "campaign_targets_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

