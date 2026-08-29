-- AlterTable
ALTER TABLE "human_approvals" ALTER COLUMN "resolved_by" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "human_approvals" ADD CONSTRAINT "human_approvals_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "workflow_human_steps_run_id_node_id_idx" ON "workflow_human_steps"("run_id", "node_id");

-- CreateIndex
CREATE UNIQUE INDEX "autonomy_policies_global_default_key" ON "autonomy_policies"("is_default") WHERE "is_default" = true AND "team_id" IS NULL AND "template_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "autonomy_policies_team_default_key" ON "autonomy_policies"("team_id") WHERE "is_default" = true AND "template_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "autonomy_policies_template_key" ON "autonomy_policies"("template_id") WHERE "template_id" IS NOT NULL;
