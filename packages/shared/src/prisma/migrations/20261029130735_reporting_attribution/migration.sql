-- AlterTable
ALTER TABLE "human_approvals" ADD COLUMN     "resolved_via" TEXT;

-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN     "run_id" UUID,
ADD COLUMN     "template_id" UUID,
ADD COLUMN     "template_version" INTEGER;

-- AlterTable
ALTER TABLE "workflow_human_steps" ADD COLUMN     "resolved_via" TEXT;

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "attributed_org_id" UUID,
ADD COLUMN     "attributed_team_id" UUID;

-- CreateIndex
CREATE INDEX "pull_requests_template_id_opened_at_idx" ON "pull_requests"("template_id", "opened_at");

-- CreateIndex
CREATE INDEX "workflow_runs_attributed_team_id_started_at_idx" ON "workflow_runs"("attributed_team_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_runs_attributed_org_id_started_at_idx" ON "workflow_runs"("attributed_org_id", "started_at");

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_attributed_team_id_fkey" FOREIGN KEY ("attributed_team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_attributed_org_id_fkey" FOREIGN KEY ("attributed_org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

UPDATE "workflow_runs" AS target
SET
  "attributed_team_id" = selected_team."id",
  "attributed_org_id" = COALESCE(selected_team."org_id", work_request."billing_org_id")
FROM "workflow_runs" AS source
LEFT JOIN "active_workflows" AS active_workflow
  ON active_workflow."temporal_workflow_id" = source."workflow_id"
LEFT JOIN "run_inputs" AS work_request
  ON work_request."id" = source."work_request_id"
LEFT JOIN "connections" AS run_connection
  ON run_connection."id" = COALESCE(source."connection_id", active_workflow."repo_id")
LEFT JOIN "connections" AS request_connection
  ON request_connection."id" = work_request."connection_id"
LEFT JOIN "slack_channels" AS channel
  ON channel."id" = source."channel_id"
LEFT JOIN "service_principals" AS requester
  ON requester."id" = work_request."requested_by_service_id"
LEFT JOIN "workflow_templates" AS template
  ON template."id" = source."template_id"
LEFT JOIN "teams" AS selected_team
  ON selected_team."id" = COALESCE(
    run_connection."team_id",
    request_connection."team_id",
    channel."team_id",
    requester."team_id",
    template."team_id"
  )
WHERE target."id" = source."id"
  AND COALESCE(selected_team."org_id", work_request."billing_org_id") IS NOT NULL;

UPDATE "pull_requests" AS pull_request
SET
  "run_id" = selected_run."id",
  "template_id" = selected_run."template_id",
  "template_version" = selected_run."template_version"
FROM "active_workflows" AS active_workflow
JOIN "workflow_runs" AS selected_run
  ON selected_run."workflow_id" = active_workflow."temporal_workflow_id"
WHERE pull_request."workflow_id" = active_workflow."id"
  AND pull_request."repo_id" = active_workflow."repo_id";

ALTER TABLE "pull_requests" VALIDATE CONSTRAINT "pull_requests_template_id_fkey";
ALTER TABLE "pull_requests" VALIDATE CONSTRAINT "pull_requests_run_id_fkey";
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "workflow_runs_attributed_team_id_fkey";
ALTER TABLE "workflow_runs" VALIDATE CONSTRAINT "workflow_runs_attributed_org_id_fkey";
