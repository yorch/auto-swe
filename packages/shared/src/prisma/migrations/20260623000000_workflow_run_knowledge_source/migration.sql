CREATE TYPE "WorkflowRunKnowledgeSourceKind" AS ENUM ('UNKNOWN', 'REPOSITORY', 'TEAM');

ALTER TABLE "workflow_runs"
  ADD COLUMN "knowledge_source_kind" "WorkflowRunKnowledgeSourceKind",
  ADD COLUMN "knowledge_source_repo_id" UUID,
  ADD COLUMN "knowledge_source_team_id" UUID,
  ADD COLUMN "knowledge_source_org_id" UUID;
