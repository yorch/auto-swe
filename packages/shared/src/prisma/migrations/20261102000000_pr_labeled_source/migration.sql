-- The pull-request label source (`github.pull_request.labeled`, `docs/automations.md`). It adds
-- no table or column: only the hand-written `automations_source_known` check, which Prisma cannot
-- express (the skill `prisma-pgvector-hnsw`), names the sources, so there is no generated DDL here.

-- `automations_source_known` cannot be altered in place, so it is replaced with the source added.
ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
    CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event', 'github.pull_request.feedback', 'github.pull_request.labeled', 'jira.filter.new_issue', 'jira.filter.status_changed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A CHECK that evaluates to NULL passes; COALESCE makes a missing list fail instead of passing
-- it, as in the sibling per-source checks.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_pr_labeled_filters"
    CHECK ("source" <> 'github.pull_request.labeled' OR COALESCE(
      "filters" ? 'labels'
      AND jsonb_typeof("filters"->'labels') = 'array'
      AND jsonb_array_length("filters"->'labels') > 0,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
