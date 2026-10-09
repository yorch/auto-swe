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
