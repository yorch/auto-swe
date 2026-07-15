-- ----------------------------------------------------------------------------
-- Data-model integrity fixes from the 2026-07 review pass. Additive and safe
-- to `migrate deploy` against an existing DB — orphan rows are scrubbed before
-- any FK is added, and array columns are coalesced before SET NOT NULL.
-- ----------------------------------------------------------------------------

-- ── D1: Agent scope/discriminator CHECK ─────────────────────────────────────
-- Mirrors `provider_credentials_scope_keys_check` (0001): the scope
-- discriminator column must be non-null and every other scope column null.
ALTER TABLE "agents" ADD CONSTRAINT "agents_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
);

-- ── D2: MemoryItem team_id/org_id FKs ────────────────────────────────────────
-- `team_id`/`org_id` were denormalized onto memory_items (channel-assistant
-- team-memory widening) without FKs. Scrub any orphans first (pre-existing
-- rows pointing at a deleted team/org), then add the FKs so future deletes
-- cascade instead of leaving dangling references.
UPDATE "memory_items" m SET "team_id" = NULL WHERE "team_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."id" = m."team_id");
UPDATE "memory_items" m SET "org_id" = NULL WHERE "org_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = m."org_id");

ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── D3: singleton system-config CHECKs ──────────────────────────────────────
-- `issue_tracker_config`, `knowledge_base_config`, and `figma_config` were
-- added after the 0001 singleton-CHECK sweep and never got one. Same
-- belt-and-suspenders rationale as 0001: the Prisma model already defaults
-- `id` to `'default'`, this just guards against raw SQL inserts.
ALTER TABLE "issue_tracker_config"  ADD CONSTRAINT "issue_tracker_config_singleton"  CHECK ("id" = 'default');
ALTER TABLE "knowledge_base_config" ADD CONSTRAINT "knowledge_base_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "figma_config"          ADD CONSTRAINT "figma_config_singleton"          CHECK ("id" = 'default');

-- ── D4: covering indexes for FK / hot-lookup columns ────────────────────────
-- These columns are either FK'd or filtered on directly but only ever
-- appeared as a non-leading member of a composite index (or not indexed at
-- all), so lookups/deletes on them force a seq scan.
CREATE INDEX "connections_team_id_idx" ON "connections" ("team_id");

CREATE INDEX "run_inputs_connection_id_idx" ON "run_inputs" ("connection_id");
CREATE INDEX "run_inputs_requested_by_id_idx" ON "run_inputs" ("requested_by_id");
CREATE INDEX "run_inputs_external_ticket_id_idx" ON "run_inputs" ("external_ticket_id");

CREATE INDEX "scheduled_work_requests_template_id_idx" ON "scheduled_work_requests" ("template_id");
CREATE INDEX "scheduled_work_requests_created_by_id_idx" ON "scheduled_work_requests" ("created_by_id");
CREATE INDEX "scheduled_work_requests_work_request_id_idx" ON "scheduled_work_requests" ("work_request_id");

CREATE INDEX "memory_items_workflow_id_idx" ON "memory_items" ("workflow_id");
CREATE INDEX "memory_items_workflow_run_id_idx" ON "memory_items" ("workflow_run_id");

-- agents already has (scope, team_id) / (scope, org_id) / (scope, channel_id) /
-- (scope, workflow_template_id) composite indexes from init, but those don't
-- cover a lookup/delete filtered on the FK column alone (scope isn't a
-- leading-column match). Add single-column indexes for each FK.
CREATE INDEX "agents_team_id_idx" ON "agents" ("team_id");
CREATE INDEX "agents_org_id_idx" ON "agents" ("org_id");
CREATE INDEX "agents_channel_id_idx" ON "agents" ("channel_id");
CREATE INDEX "agents_workflow_template_id_idx" ON "agents" ("workflow_template_id");

-- Same story for provider_credentials: (provider, scope, team_id) /
-- (provider, scope, org_id) composites from init don't cover a bare
-- team_id/org_id filter.
CREATE INDEX "provider_credentials_team_id_idx" ON "provider_credentials" ("team_id");
CREATE INDEX "provider_credentials_org_id_idx" ON "provider_credentials" ("org_id");

-- ── D5: reinstate NOT NULL on TEXT[] columns ────────────────────────────────
-- Same Prisma-7-emits-nullable-arrays gap that 0001 fixed for
-- teams.egress_allowlist / workflow_shell_audit.egress_allowlist_snapshot /
-- memory_items.skills_active. These four were missed in that sweep.
UPDATE "context_snapshots" SET "success_criteria" = ARRAY[]::TEXT[] WHERE "success_criteria" IS NULL;
ALTER TABLE "context_snapshots" ALTER COLUMN "success_criteria" SET NOT NULL;

UPDATE "teams" SET "shell_image_allowlist" = ARRAY[]::TEXT[] WHERE "shell_image_allowlist" IS NULL;
ALTER TABLE "teams" ALTER COLUMN "shell_image_allowlist" SET NOT NULL;

UPDATE "eval_cases" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
ALTER TABLE "eval_cases" ALTER COLUMN "tags" SET NOT NULL;

UPDATE "knowledge_base_config" SET "spaces" = ARRAY[]::TEXT[] WHERE "spaces" IS NULL;
ALTER TABLE "knowledge_base_config" ALTER COLUMN "spaces" SET NOT NULL;

-- ── D6: PullRequest (repo_id, pr_number) partial unique ─────────────────────
-- NOTE: this fails to apply if duplicate (repo_id, pr_number) rows already
-- exist in the target DB (fine on a clean/consolidated-baseline DB — dedupe
-- manually first on an older DB that has drifted).
CREATE UNIQUE INDEX "pull_requests_repo_id_pr_number_uidx" ON "pull_requests" ("repo_id", "pr_number") WHERE "pr_number" IS NOT NULL;

-- ── D7: Int → BigInt token counters ──────────────────────────────────────────
-- Cumulative token counters can exceed the 2^31-1 INTEGER ceiling over a
-- long-running workflow / long-lived ActiveWorkflow row.
ALTER TABLE "workflow_runs"    ALTER COLUMN "tokens_input_total"  TYPE BIGINT;
ALTER TABLE "workflow_runs"    ALTER COLUMN "tokens_output_total" TYPE BIGINT;
ALTER TABLE "active_workflows" ALTER COLUMN "tokens_input_used"   TYPE BIGINT;
ALTER TABLE "active_workflows" ALTER COLUMN "tokens_output_used"  TYPE BIGINT;
