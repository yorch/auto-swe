-- A decision taken again (a redelivered failed start, or a manager's retry) keeps its row,
-- moved aside under `<dedupe key>~<its id>` and marked here; the new decision holds the key.
ALTER TABLE "automation_fires" ADD COLUMN "retried_at" TIMESTAMPTZ;

-- Scheduled GitHub Actions runs are a CI event a trigger can react to.
ALTER TABLE "automations" DROP CONSTRAINT "automations_workflow_run_failed_filters";
ALTER TABLE "automations" ADD CONSTRAINT "automations_workflow_run_failed_filters"
  CHECK ("source" <> 'github.workflow_run.failed' OR COALESCE(
    "filters" ?& ARRAY['events', 'branchPatterns', 'workflowPatterns']
    AND jsonb_typeof("filters"->'events') = 'array'
    AND jsonb_typeof("filters"->'branchPatterns') = 'array'
    AND jsonb_typeof("filters"->'workflowPatterns') = 'array'
    AND jsonb_array_length("filters"->'events') > 0
    AND ("filters"->'events') <@ '["push", "pull_request", "schedule"]'::jsonb
    AND jsonb_array_length("filters"->'branchPatterns') > 0
    AND jsonb_array_length("filters"->'workflowPatterns') > 0,
    false
  ));

-- The retention sweep reads decisions that started no run, oldest first. Partial, so the
-- started decisions the guards read (kept for good) do not grow it. Hand-written: Prisma cannot
-- express a partial index (see the prisma-pgvector-hnsw skill).
CREATE INDEX "automation_fires_prunable_created_at_idx"
  ON "automation_fires" ("created_at") WHERE "outcome" <> 'STARTED';

-- Issue-label automations: a second source, with filters that name at least one label.
ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
  CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled'));
ALTER TABLE "automations" ADD CONSTRAINT "automations_issues_labeled_filters"
  CHECK ("source" <> 'github.issues.labeled' OR COALESCE(
    "filters" ? 'labels'
    AND jsonb_typeof("filters"->'labels') = 'array'
    AND jsonb_array_length("filters"->'labels') > 0,
    false
  ));
