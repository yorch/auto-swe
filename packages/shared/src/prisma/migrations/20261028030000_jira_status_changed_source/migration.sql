-- The Jira status-change source (`jira.filter.status_changed`, `docs/automations.md` §3.2). It
-- polls like `jira.filter.new_issue` and reuses its poll-state and seen-issue tables unchanged:
-- the seen set holds `<key>#<status>` pairs for it, which the existing lower-case CHECK admits. Only
-- the two hand-written checks that name the sibling source change; Prisma cannot express either
-- (the skill `prisma-pgvector-hnsw`), so there is no generated DDL in this migration.

-- `automations_source_known` cannot be altered in place, so it is replaced with the source added.
ALTER TABLE "automations" DROP CONSTRAINT "automations_source_known";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_source_known"
    CHECK ("source" IN ('github.workflow_run.failed', 'github.issues.labeled', 'inbound.event', 'github.pull_request.feedback', 'jira.filter.new_issue', 'jira.filter.status_changed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Both Jira filter sources hold a non-empty JQL string and live on a repository.
ALTER TABLE "automations" DROP CONSTRAINT "automations_jira_filter_filters";
DO $$ BEGIN
  ALTER TABLE "automations" ADD CONSTRAINT "automations_jira_filter_filters"
    CHECK ("source" NOT IN ('jira.filter.new_issue', 'jira.filter.status_changed') OR COALESCE(
      "connection_id" IS NOT NULL
      AND jsonb_typeof("filters") = 'object'
      AND "filters" ? 'jql'
      AND jsonb_typeof("filters"->'jql') = 'string'
      AND length(btrim("filters"->>'jql')) > 0,
      false
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
