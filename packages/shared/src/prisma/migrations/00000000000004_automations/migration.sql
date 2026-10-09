-- CI-failure triggers become the first kind of event automation (docs/automations.md).
-- Renamed in place, not copied: every trigger, decision and its data is kept, and the rename
-- is atomic per statement. The trigger's three lists become the source's `filters` JSON; the
-- decision ledger is keyed on the repository and outlives the automation that wrote it.

-- ── automations ──────────────────────────────────────────────────────────────
ALTER TABLE "ci_failure_triggers" RENAME TO "automations";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_pkey" TO "automations_pkey";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_connection_id_fkey" TO "automations_connection_id_fkey";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_template_id_fkey" TO "automations_template_id_fkey";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_created_by_id_fkey" TO "automations_created_by_id_fkey";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_bounds" TO "automations_bounds";
ALTER TABLE "automations" RENAME CONSTRAINT "ci_failure_triggers_inputs_object" TO "automations_inputs_object";

ALTER TABLE "automations" ADD COLUMN "source" TEXT, ADD COLUMN "filters" JSONB;
UPDATE "automations" SET
  "source" = 'github.workflow_run.failed',
  "filters" = jsonb_build_object(
    'events', to_jsonb("events"),
    'branchPatterns', to_jsonb("branch_patterns"),
    'workflowPatterns', to_jsonb("workflow_patterns")
  );
ALTER TABLE "automations" ALTER COLUMN "source" SET NOT NULL, ALTER COLUMN "filters" SET NOT NULL;

ALTER TABLE "automations" DROP CONSTRAINT "ci_failure_triggers_lists_nonempty";
ALTER TABLE "automations" DROP CONSTRAINT "ci_failure_triggers_events_known";
ALTER TABLE "automations" DROP COLUMN "events", DROP COLUMN "branch_patterns", DROP COLUMN "workflow_patterns";

DROP INDEX "ci_failure_triggers_connection_id_idx";
CREATE INDEX "automations_connection_id_source_idx" ON "automations"("connection_id", "source");

-- Hand-written: DDL the Prisma schema cannot express (see the prisma-pgvector-hnsw skill).
-- A source this build does not know is never stored, and each source's filters keep the
-- invariants the CI trigger's columns had: lists that are never empty (an empty list reads as
-- "match nothing" in code but "match everything" to a person) and only known events.
ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
  CHECK ("source" IN ('github.workflow_run.failed'));
ALTER TABLE "automations" ADD CONSTRAINT "automations_filters_object"
  CHECK (jsonb_typeof("filters") = 'object');
-- A CHECK that evaluates to NULL passes, and every term below is NULL when its key is missing;
-- COALESCE makes a missing list fail the check instead of passing it.
ALTER TABLE "automations" ADD CONSTRAINT "automations_workflow_run_failed_filters"
  CHECK ("source" <> 'github.workflow_run.failed' OR COALESCE(
    "filters" ?& ARRAY['events', 'branchPatterns', 'workflowPatterns']
    AND jsonb_typeof("filters"->'events') = 'array'
    AND jsonb_typeof("filters"->'branchPatterns') = 'array'
    AND jsonb_typeof("filters"->'workflowPatterns') = 'array'
    AND jsonb_array_length("filters"->'events') > 0
    AND ("filters"->'events') <@ '["push", "pull_request"]'::jsonb
    AND jsonb_array_length("filters"->'branchPatterns') > 0
    AND jsonb_array_length("filters"->'workflowPatterns') > 0,
    false
  ));

-- ── automation_fires ─────────────────────────────────────────────────────────
ALTER TABLE "ci_failure_trigger_fires" RENAME TO "automation_fires";
ALTER TABLE "automation_fires" RENAME CONSTRAINT "ci_failure_trigger_fires_pkey" TO "automation_fires_pkey";

-- The ledger outlives its automation: what was decided, and what a run pushed, must not be
-- forgotten when an automation is deleted and recreated.
ALTER TABLE "automation_fires" DROP CONSTRAINT "ci_failure_trigger_fires_trigger_id_fkey";
ALTER TABLE "automation_fires" RENAME COLUMN "trigger_id" TO "automation_id";
ALTER TABLE "automation_fires" ALTER COLUMN "automation_id" DROP NOT NULL;
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_automation_id_fkey"
  FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "automation_fires" RENAME COLUMN "head_branch" TO "scope_key";
ALTER TABLE "automation_fires" RENAME COLUMN "head_sha" TO "subject_key";
ALTER TABLE "automation_fires" RENAME COLUMN "fix_commit_sha" TO "produced_key";

ALTER TABLE "automation_fires"
  ADD COLUMN "connection_id" UUID,
  ADD COLUMN "repo_key" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "facts" JSONB NOT NULL DEFAULT '{}';
-- The dedupe key is `<host>/<owner>/<repo>#<run>/<attempt>`: the repository is its prefix.
UPDATE "automation_fires" AS f SET
  "repo_key" = split_part(f."dedupe_key", '#', 1),
  "source" = 'github.workflow_run.failed',
  "connection_id" = (SELECT a."connection_id" FROM "automations" AS a WHERE a."id" = f."automation_id"),
  "facts" = jsonb_build_object(
    'branch', f."scope_key",
    'headSha', f."subject_key",
    'event', f."event",
    'workflowPath', f."workflow_path",
    'runId', f."github_run_id",
    'runAttempt', f."run_attempt",
    'pullRequestNumber', f."pull_request_number"
  ),
  "outcome" = CASE f."outcome"
    WHEN 'SUPPRESSED_OWN_FIX' THEN 'SUPPRESSED_OWN_OUTPUT'
    WHEN 'SUPPRESSED_SAME_COMMIT' THEN 'SUPPRESSED_SAME_SUBJECT'
    WHEN 'SUPPRESSED_NO_PULL_REQUEST' THEN 'SUPPRESSED_PRECONDITION'
    ELSE f."outcome"
  END;
ALTER TABLE "automation_fires" ALTER COLUMN "repo_key" SET NOT NULL, ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "automation_fires"
  DROP COLUMN "github_run_id",
  DROP COLUMN "run_attempt",
  DROP COLUMN "workflow_path",
  DROP COLUMN "event",
  DROP COLUMN "pull_request_number";
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER INDEX "ci_failure_trigger_fires_dedupe_key_key" RENAME TO "automation_fires_dedupe_key_key";
ALTER INDEX "ci_failure_trigger_fires_trigger_id_created_at_idx" RENAME TO "automation_fires_automation_id_created_at_idx";
ALTER INDEX "ci_failure_trigger_fires_fix_commit_sha_idx" RENAME TO "automation_fires_produced_key_idx";
ALTER INDEX "ci_failure_trigger_fires_work_request_id_idx" RENAME TO "automation_fires_work_request_id_idx";
DROP INDEX "ci_failure_trigger_fires_trigger_id_head_branch_created_at_idx";
DROP INDEX "ci_failure_trigger_fires_trigger_id_head_sha_idx";
CREATE INDEX "automation_fires_repo_key_scope_key_created_at_idx" ON "automation_fires"("repo_key", "scope_key", "created_at");
CREATE INDEX "automation_fires_repo_key_subject_key_idx" ON "automation_fires"("repo_key", "subject_key");
