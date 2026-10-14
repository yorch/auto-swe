-- CreateIndex
CREATE INDEX "agent_skill_refs_skill_id_idx" ON "agent_skill_refs"("skill_id");

-- CreateIndex
CREATE INDEX "automation_fires_connection_id_idx" ON "automation_fires"("connection_id");

-- CreateIndex
CREATE INDEX "automations_template_id_idx" ON "automations"("template_id");

-- CreateIndex
CREATE INDEX "automations_created_by_id_idx" ON "automations"("created_by_id");

-- CreateIndex
CREATE INDEX "human_approvals_resolved_by_idx" ON "human_approvals"("resolved_by");

-- CreateIndex
CREATE INDEX "knowledge_items_origin_team_id_idx" ON "knowledge_items"("origin_team_id");

-- CreateIndex
CREATE INDEX "knowledge_items_approved_by_id_idx" ON "knowledge_items"("approved_by_id");

-- CreateIndex
CREATE INDEX "trusted_knowledge_evidence_artifact_id_idx" ON "trusted_knowledge_evidence"("artifact_id");

-- CreateIndex
CREATE INDEX "workflow_human_steps_resolved_by_idx" ON "workflow_human_steps"("resolved_by");

-- CreateIndex
CREATE INDEX "workflow_runs_started_at_idx" ON "workflow_runs"("started_at");

-- CreateIndex
CREATE INDEX "workflow_runs_status_started_at_idx" ON "workflow_runs"("status", "started_at");
