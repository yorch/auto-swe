ALTER TABLE "run_inputs"
  ADD COLUMN "knowledge_source_kind" "WorkflowRunKnowledgeSourceKind",
  ADD COLUMN "knowledge_source_repo_id" UUID,
  ADD COLUMN "knowledge_source_team_id" UUID,
  ADD COLUMN "knowledge_source_org_id" UUID,
  ADD COLUMN "knowledge_repo_sources" JSONB;

ALTER TABLE "active_workflows"
  ADD COLUMN "knowledge_source_kind" "WorkflowRunKnowledgeSourceKind",
  ADD COLUMN "knowledge_source_repo_id" UUID,
  ADD COLUMN "knowledge_source_team_id" UUID,
  ADD COLUMN "knowledge_source_org_id" UUID;
