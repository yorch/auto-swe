-- Prisma derives a foreign key's name from its field (`<field>_fkey`) and an index's name from the
-- columns it covers (`<table>_<columns>_key` / `_idx`), so the names these tables were created with
-- do not match what `prisma migrate diff` reads back — the drift check in CI reports them as
-- unexpected. Renaming is the record of that: cheaper and safer than dropping and recreating the
-- constraints, and it leaves every row where it is.
--
-- `evidence_correlation` is declared with a database default in the schema but was created without
-- one, so the same check asks for the default to be applied.

ALTER TABLE "knowledge_items"
  RENAME CONSTRAINT "knowledge_items_owner_team_fkey" TO "knowledge_items_owner_team_id_fkey";
ALTER TABLE "knowledge_items"
  RENAME CONSTRAINT "knowledge_items_org_fkey" TO "knowledge_items_org_id_fkey";
ALTER TABLE "knowledge_items"
  RENAME CONSTRAINT "knowledge_items_origin_team_fkey" TO "knowledge_items_origin_team_id_fkey";
ALTER TABLE "knowledge_items"
  RENAME CONSTRAINT "knowledge_items_repo_fkey" TO "knowledge_items_repo_id_fkey";
ALTER TABLE "knowledge_items"
  RENAME CONSTRAINT "knowledge_items_approved_by_fkey" TO "knowledge_items_approved_by_id_fkey";

ALTER TABLE "knowledge_item_team_grants"
  RENAME CONSTRAINT "knowledge_item_team_grants_item_fkey" TO "knowledge_item_team_grants_knowledge_item_id_fkey";
ALTER TABLE "knowledge_item_team_grants"
  RENAME CONSTRAINT "knowledge_item_team_grants_team_fkey" TO "knowledge_item_team_grants_team_id_fkey";

ALTER TABLE "knowledge_item_events"
  RENAME CONSTRAINT "knowledge_item_events_item_fkey" TO "knowledge_item_events_knowledge_item_id_fkey";
ALTER TABLE "knowledge_item_events"
  RENAME CONSTRAINT "knowledge_item_events_actor_fkey" TO "knowledge_item_events_actor_id_fkey";

ALTER TABLE "trusted_knowledge_evidence"
  RENAME CONSTRAINT "trusted_knowledge_evidence_run_fkey" TO "trusted_knowledge_evidence_run_id_fkey";
ALTER TABLE "trusted_knowledge_evidence"
  RENAME CONSTRAINT "trusted_knowledge_evidence_artifact_fkey" TO "trusted_knowledge_evidence_artifact_id_fkey";

-- Both sides of each rename below are what PostgreSQL actually stored: it truncates an identifier to
-- 63 bytes, and the schema-derived name and the original one truncate at different points.
ALTER INDEX "knowledge_items_producer_run_id_producer_node_id_idempotency_ke"
  RENAME TO "knowledge_items_producer_run_id_producer_node_id_idempotenc_key";
ALTER INDEX "trusted_knowledge_evidence_execution_key"
  RENAME TO "trusted_knowledge_evidence_run_id_recording_id_step_attempt_key";
ALTER INDEX "trusted_knowledge_evidence_run_artifact_idx"
  RENAME TO "trusted_knowledge_evidence_run_id_artifact_id_idx";

ALTER TABLE "trusted_knowledge_evidence"
  ALTER COLUMN "evidence_correlation" SET DEFAULT gen_random_uuid()::text;
