-- ----------------------------------------------------------------------------
-- Custom DDL that Prisma's schema DSL cannot express. Applied immediately after
-- the consolidated `00000000000000_init` baseline that the Prisma generator
-- produced. Everything Prisma *can* express (tables, columns, standard indexes,
-- FKs — including the memory_items team/org FKs, the single-column FK covering
-- indexes, and the BigInt token counters) lives in that generated baseline;
-- only the constructs below (CHECK constraints, partial unique indexes, the
-- pgvector HNSW index, array NOT NULL, seeds) require hand-written SQL.
-- ----------------------------------------------------------------------------

-- Raw pgvector HNSW index on memory_items.embedding. Prisma 7's schema DSL
-- cannot model HNSW/IVFFlat indexes, so it lives here rather than in `init`.
-- Routine application is `yarn db:migrate` (deploy); `prisma migrate dev`
-- cannot see HNSW indexes and will try to re-drop this one on the next
-- unrelated schema change — see the project skill
-- `prisma-7-pgvector-hnsw-migrate-dev-drift` for the workflow.
CREATE INDEX IF NOT EXISTS "idx_memory_items_embedding" ON "memory_items"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- ── Provider credentials (GLOBAL, ORGANIZATION, or TEAM; no template scope) ──
ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_check"
    CHECK ("scope" IN ('GLOBAL', 'ORGANIZATION', 'TEAM'));

CREATE UNIQUE INDEX "provider_credentials_global_unique"
    ON "provider_credentials" ("provider")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "provider_credentials_org_unique"
    ON "provider_credentials" ("provider", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX "provider_credentials_team_unique"
    ON "provider_credentials" ("provider", "team_id")
    WHERE "scope" = 'TEAM';

ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );

-- ── Skills: same scope-discriminator rule as provider credentials ───────────
-- Skills are GLOBAL platform content or owned by one tenant. Without this a
-- GLOBAL row could carry a team_id and leak into that tenant's filtered view,
-- and a TEAM row could exist with no owner to filter on.
ALTER TABLE "skills"
    ADD CONSTRAINT "skills_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "org_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );

-- ── Connections: git_repo identity uniqueness (partial) ─────────────────────
-- org/repo are nullable so non-git connection types (e.g. `mcp`) need not set
-- them; uniqueness applies only to git_repo rows. Prisma can't express a
-- partial `@@unique`, so it lives here.
CREATE UNIQUE INDEX "connections_git_repo_org_repo_uidx"
    ON "connections" ("organization_name", "repo_name")
    WHERE "type" = 'git_repo';

-- ── Agent library: one row per (key, version) at a scope ─────────────────────
-- Partial uniques per scope; Prisma can't express `WHERE scope = …`. Postgres
-- treats NULL discriminators as distinct, so each WHERE scopes its uniqueness.
CREATE UNIQUE INDEX "agents_key_version_global_uidx"
    ON "agents" ("key", "version")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agents_key_version_org_uidx"
    ON "agents" ("key", "version", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX "agents_key_version_team_uidx"
    ON "agents" ("key", "version", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agents_key_version_channel_uidx"
    ON "agents" ("key", "version", "channel_id")
    WHERE "scope" = 'CHANNEL';

CREATE UNIQUE INDEX "agents_key_version_template_uidx"
    ON "agents" ("key", "version", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- Agent scope/discriminator integrity: the scope discriminator column must be
-- non-null and every other scope column null. Mirrors
-- `provider_credentials_scope_keys_check`, extended to all five agent scopes.
-- Complements the partial uniques above (which, because Postgres treats NULL
-- discriminators as distinct, could otherwise admit multiple mis-scoped rows).
ALTER TABLE "agents" ADD CONSTRAINT "agents_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
);

-- ── HITL idempotency ─────────────────────────────────────────────────────────
-- Prevents duplicate PENDING rows for the same (run_id, node_id) pair while
-- allowing multiple historical resolved/cancelled rows (retry loops).
CREATE UNIQUE INDEX workflow_human_steps_pending_unique
  ON workflow_human_steps (run_id, node_id)
  WHERE status = 'PENDING';

-- ── Pull requests: one row per (repo_id, pr_number) (partial) ────────────────
-- pr_number is nullable (the row is created before the PR number is known), so
-- the uniqueness applies only once it's set. Prisma can't express a partial
-- `@@unique`. NOTE: fails to apply if duplicate (repo_id, pr_number) rows
-- already exist — fine on a clean/consolidated-baseline DB.
CREATE UNIQUE INDEX "pull_requests_repo_id_pr_number_uidx"
    ON "pull_requests" ("repo_id", "pr_number")
    WHERE "pr_number" IS NOT NULL;

-- ── Singleton system-config tables ───────────────────────────────────────────
-- The `id` column must always be the literal 'default'. The Prisma models use
-- `@default("default")` so client writes always produce the right value; these
-- checks are belt-and-suspenders against raw SQL inserts.
ALTER TABLE "github_config"
    ADD CONSTRAINT "github_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "slack_config"
    ADD CONSTRAINT "slack_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "storage_config"
    ADD CONSTRAINT "storage_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "storage_config"
    ADD CONSTRAINT "storage_config_backend_check" CHECK ("backend" IN ('inline', 's3'));
ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_singleton" CHECK ("id" = 'default');
-- CI-wait strategy. All four columns are nullable: NULL means "not configured
-- in the DB", so the resolver falls back to CI_WAIT_MODE / CI_POLL_*. Reject a
-- typo here rather than silently degrading to 'signal', and reject a
-- non-positive interval, which would busy-loop the CI poller.
ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_ci_wait_mode_check"
    CHECK ("ci_wait_mode" IS NULL OR "ci_wait_mode" IN ('signal', 'poll'));
ALTER TABLE "workflow_defaults"
    ADD CONSTRAINT "workflow_defaults_ci_poll_positive_check"
    CHECK (
        ("ci_poll_interval_sec" IS NULL OR "ci_poll_interval_sec" > 0)
        AND ("ci_poll_grace_sec"    IS NULL OR "ci_poll_grace_sec"    > 0)
        AND ("ci_poll_deadline_sec" IS NULL OR "ci_poll_deadline_sec" > 0)
    );
ALTER TABLE "google_oauth_config"
    ADD CONSTRAINT "google_oauth_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "okta_oauth_config"
    ADD CONSTRAINT "okta_oauth_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "embedding_configs"
    ADD CONSTRAINT "embedding_configs_singleton_check" CHECK ("id" = 'default');
ALTER TABLE "issue_tracker_config"
    ADD CONSTRAINT "issue_tracker_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "knowledge_base_config"
    ADD CONSTRAINT "knowledge_base_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "figma_config"
    ADD CONSTRAINT "figma_config_singleton" CHECK ("id" = 'default');

-- ── Config registry: scope discriminator + per-scope uniqueness ──────────────
-- Same shape as `agents` above: exactly the id column for the row's own scope
-- may be set, so a TEAM override can never also carry an org id.
ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
);

-- One override per key per scope instance. Partial per scope because Prisma
-- cannot express `WHERE scope = …` in a unique index — the same reason writes
-- use findFirst-then-create instead of upsert.
CREATE UNIQUE INDEX "config_settings_global_uidx"
    ON "config_settings" ("key")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "config_settings_org_uidx"
    ON "config_settings" ("key", "org_id")
    WHERE "scope" = 'ORGANIZATION';

CREATE UNIQUE INDEX "config_settings_team_uidx"
    ON "config_settings" ("key", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "config_settings_channel_uidx"
    ON "config_settings" ("key", "channel_id")
    WHERE "scope" = 'CHANNEL';

CREATE UNIQUE INDEX "config_settings_template_uidx"
    ON "config_settings" ("key", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- ── Config permissions: one grantee, tenant-level scopes only ────────────────
-- A grant names exactly one grantee: a specific user, or every holder of a role.
ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_grantee_check" CHECK (
    ("user_id" IS NOT NULL AND "role" IS NULL)
 OR ("user_id" IS NULL AND "role" IS NOT NULL)
);

-- Grants are only meaningful down to a tenant boundary: a CHANNEL- or
-- TEMPLATE-scoped grant would be narrower than the thing an operator actually
-- administers, so authority is expressed at GLOBAL, ORGANIZATION, or TEAM and
-- covers everything beneath it. `ConfigScope` also permits CHANNEL and
-- WORKFLOW_TEMPLATE, so a row carrying either fails every branch and is
-- rejected.
ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'       AND "team_id" IS NULL AND "org_id" IS NULL)
 OR ("scope" = 'ORGANIZATION' AND "org_id" IS NOT NULL AND "team_id" IS NULL)
 OR ("scope" = 'TEAM'         AND "team_id" IS NOT NULL AND "org_id" IS NULL)
);

-- One grant per (pattern, grantee, scope instance) so re-granting is idempotent.
CREATE UNIQUE INDEX "config_permissions_user_global_uidx"
    ON "config_permissions" ("key_pattern", "user_id")
    WHERE "scope" = 'GLOBAL' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX "config_permissions_role_global_uidx"
    ON "config_permissions" ("key_pattern", "role")
    WHERE "scope" = 'GLOBAL' AND "role" IS NOT NULL;

CREATE UNIQUE INDEX "config_permissions_user_org_uidx"
    ON "config_permissions" ("key_pattern", "user_id", "org_id")
    WHERE "scope" = 'ORGANIZATION' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX "config_permissions_role_org_uidx"
    ON "config_permissions" ("key_pattern", "role", "org_id")
    WHERE "scope" = 'ORGANIZATION' AND "role" IS NOT NULL;

CREATE UNIQUE INDEX "config_permissions_user_team_uidx"
    ON "config_permissions" ("key_pattern", "user_id", "team_id")
    WHERE "scope" = 'TEAM' AND "user_id" IS NOT NULL;

CREATE UNIQUE INDEX "config_permissions_role_team_uidx"
    ON "config_permissions" ("key_pattern", "role", "team_id")
    WHERE "scope" = 'TEAM' AND "role" IS NOT NULL;

-- ── NOT NULL on array columns ────────────────────────────────────────────────
-- Prisma 7's generator emits `String[]` columns as nullable at the DB level
-- even though the client treats them as always-non-null — reinstate the
-- DB-level constraint. (Coalesce first so a stray NULL can't block the ALTER.)
UPDATE "teams" SET "egress_allowlist" = ARRAY[]::TEXT[] WHERE "egress_allowlist" IS NULL;
ALTER TABLE "teams"
  ALTER COLUMN "egress_allowlist" SET NOT NULL;

UPDATE "workflow_shell_audit" SET "egress_allowlist_snapshot" = ARRAY[]::TEXT[] WHERE "egress_allowlist_snapshot" IS NULL;
ALTER TABLE "workflow_shell_audit"
  ALTER COLUMN "egress_allowlist_snapshot" SET NOT NULL;

UPDATE "memory_items" SET "skills_active" = ARRAY[]::TEXT[] WHERE "skills_active" IS NULL;
ALTER TABLE "memory_items"
  ALTER COLUMN "skills_active" SET NOT NULL;

UPDATE "context_snapshots" SET "success_criteria" = ARRAY[]::TEXT[] WHERE "success_criteria" IS NULL;
ALTER TABLE "context_snapshots"
  ALTER COLUMN "success_criteria" SET NOT NULL;

UPDATE "teams" SET "shell_image_allowlist" = ARRAY[]::TEXT[] WHERE "shell_image_allowlist" IS NULL;
ALTER TABLE "teams"
  ALTER COLUMN "shell_image_allowlist" SET NOT NULL;

UPDATE "eval_cases" SET "tags" = ARRAY[]::TEXT[] WHERE "tags" IS NULL;
ALTER TABLE "eval_cases"
  ALTER COLUMN "tags" SET NOT NULL;

UPDATE "knowledge_base_config" SET "spaces" = ARRAY[]::TEXT[] WHERE "spaces" IS NULL;
ALTER TABLE "knowledge_base_config"
  ALTER COLUMN "spaces" SET NOT NULL;

-- ── Repo dependency graph ────────────────────────────────────────────────────
-- The repo_dependencies edge table and connections.package_names live in the
-- generated baseline; only these constructs need hand-written SQL.

-- Array NOT NULL for the new package_names column (Prisma emits the array column
-- without NOT NULL).
UPDATE "connections" SET "package_names" = ARRAY[]::TEXT[] WHERE "package_names" IS NULL;
ALTER TABLE "connections"
  ALTER COLUMN "package_names" SET NOT NULL;

-- Resolved edges: one per (from, to, kind, source). Suggestions carry a null
-- to_repo_id and Postgres treats NULLs as distinct, so a plain unique would let
-- duplicate suggestions through — scope real-edge uniqueness with a partial index.
CREATE UNIQUE INDEX "repo_dependencies_resolved_uidx"
  ON "repo_dependencies" ("from_repo_id", "to_repo_id", "kind", "source")
  WHERE "to_repo_id" IS NOT NULL;

-- Unresolved suggestions: one per (from, to_ref, kind, source).
CREATE UNIQUE INDEX "repo_dependencies_suggestion_uidx"
  ON "repo_dependencies" ("from_repo_id", "to_ref", "kind", "source")
  WHERE "to_repo_id" IS NULL;

-- A row points at a repo or names an unresolved ref, never neither.
ALTER TABLE "repo_dependencies"
  ADD CONSTRAINT "repo_dependencies_target_shape_check"
  CHECK ("to_repo_id" IS NOT NULL OR "to_ref" IS NOT NULL);

-- No self-edges (holds trivially when to_repo_id is null).
ALTER TABLE "repo_dependencies"
  ADD CONSTRAINT "repo_dependencies_no_self_edge_check"
  CHECK ("to_repo_id" IS NULL OR "from_repo_id" <> "to_repo_id");

-- Status / source enums kept as TEXT with a CHECK, per the enum→string house style.
ALTER TABLE "repo_dependencies"
  ADD CONSTRAINT "repo_dependencies_status_check"
  CHECK ("status" IN ('active', 'proposed', 'dismissed', 'unresolved'));
ALTER TABLE "repo_dependencies"
  ADD CONSTRAINT "repo_dependencies_source_check"
  CHECK ("source" IN ('manual', 'manifest', 'git_signal', 'inferred'));

-- ── Seeds ────────────────────────────────────────────────────────────────────
-- Default embedding config so the worker can resolve a spec before the admin
-- visits the dashboard. Overridable via /admin/model-config.
INSERT INTO "embedding_configs" ("id", "model_spec")
VALUES ('default', 'openai/text-embedding-3-large')
ON CONFLICT ("id") DO NOTHING;
