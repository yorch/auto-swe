-- The push source (`github.push`, `docs/automations.md`). It adds no table or column: only the
-- hand-written `automations_source_known` check, which Prisma cannot express (the skill
-- `prisma-pgvector-hnsw`), names the sources, so there is no generated DDL here.

-- `automations_source_known` cannot be altered in place, so it is replaced with the source added.
ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
    CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event', 'github.pull_request.feedback', 'github.pull_request.labeled', 'github.push', 'jira.filter.new_issue', 'jira.filter.status_changed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Branches are required; paths default to an empty list, but a stored row carries one. COALESCE
-- makes a missing key fail instead of passing as NULL.
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_push_filters"
    CHECK ("source" <> 'github.push' OR COALESCE(
      "filters" ? 'branches'
      AND jsonb_typeof("filters"->'branches') = 'array'
      AND jsonb_array_length("filters"->'branches') > 0
      AND (NOT ("filters" ? 'paths') OR jsonb_typeof("filters"->'paths') = 'array'),
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
