-- ----------------------------------------------------------------------------
-- Custom DDL that Prisma's schema DSL cannot express. Applied after the
-- consolidated init that the Prisma generator produced.
-- ----------------------------------------------------------------------------

-- Raw pgvector HNSW index on agent_lessons.embedding. Prisma 7's schema DSL
-- cannot model HNSW/IVFFlat indexes, so it lives in its own migration kept
-- separate from `init`. Routine application is `yarn db:migrate` (deploy);
-- `prisma migrate dev` cannot see HNSW indexes and will try to re-drop this
-- one on the next unrelated schema change — see the project skill
-- `prisma-7-pgvector-hnsw-migrate-dev-drift` for the workflow.
CREATE INDEX IF NOT EXISTS "idx_agent_lessons_embedding" ON "agent_lessons"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- ── Scope-cascade integrity (model config + credentials) ────────────────────
-- Partial unique indexes for the ConfigScope cascade (Prisma DSL can't express
-- WHERE clauses on unique indexes). At most one row per (role, scope-key) —
-- NULLs are ignored on the inactive scope's discriminator.
CREATE UNIQUE INDEX "model_role_configs_global_unique"
    ON "model_role_configs" ("role")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "model_role_configs_team_unique"
    ON "model_role_configs" ("role", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "model_role_configs_template_unique"
    ON "model_role_configs" ("role", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- Provider credentials are only GLOBAL or TEAM (no template scope by design).
ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_check"
    CHECK ("scope" IN ('GLOBAL', 'TEAM'));

CREATE UNIQUE INDEX "provider_credentials_global_unique"
    ON "provider_credentials" ("provider")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "provider_credentials_team_unique"
    ON "provider_credentials" ("provider", "team_id")
    WHERE "scope" = 'TEAM';

-- Scope-discriminator integrity: enforce that the right keys are populated
-- (or null) for each scope.
ALTER TABLE "model_role_configs"
    ADD CONSTRAINT "model_role_configs_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL AND "workflow_template_id" IS NOT NULL)
    );

ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );

-- ── Scope-cascade integrity (skills + tool configs) ─────────────────────────
ALTER TABLE "agent_skill_assignments"
    ADD CONSTRAINT "agent_skill_assignments_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL'            AND "team_id" IS NULL     AND "workflow_template_id" IS NULL)
        OR ("scope" = 'TEAM'           AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL  AND "workflow_template_id" IS NOT NULL)
    );

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_global_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_team_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_template_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

ALTER TABLE "agent_tool_configs"
    ADD CONSTRAINT "agent_tool_configs_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL'            AND "team_id" IS NULL     AND "workflow_template_id" IS NULL)
        OR ("scope" = 'TEAM'           AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL  AND "workflow_template_id" IS NOT NULL)
    );

ALTER TABLE "agent_tool_configs"
    ADD CONSTRAINT "agent_tool_configs_tools_nonempty_check"
    CHECK (cardinality("enabled_tools") >= 1);

CREATE UNIQUE INDEX "agent_tool_configs_role_global_uidx"
    ON "agent_tool_configs" ("agent_role")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agent_tool_configs_role_team_uidx"
    ON "agent_tool_configs" ("agent_role", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agent_tool_configs_role_template_uidx"
    ON "agent_tool_configs" ("agent_role", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- ── HITL idempotency ─────────────────────────────────────────────────────────
-- Prevents duplicate PENDING rows for the same (run_id, node_id) pair while
-- allowing multiple historical resolved/cancelled rows (retry loops).
CREATE UNIQUE INDEX workflow_human_steps_pending_unique
  ON workflow_human_steps (run_id, node_id)
  WHERE status = 'PENDING';

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
ALTER TABLE "google_oauth_config"
    ADD CONSTRAINT "google_oauth_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "embedding_configs"
    ADD CONSTRAINT "embedding_configs_singleton_check" CHECK ("id" = 'default');
ALTER TABLE "tracker_config"
    ADD CONSTRAINT "tracker_config_singleton" CHECK ("id" = 'default');
ALTER TABLE "tracker_config"
    ADD CONSTRAINT "tracker_config_provider_check"
    CHECK ("provider" IS NULL OR "provider" IN ('jira', 'linear', 'github'));

-- ── Seeds ────────────────────────────────────────────────────────────────────
-- Default embedding config so the worker can resolve a spec before the admin
-- visits the dashboard. Overridable via /admin/model-config.
INSERT INTO "embedding_configs" ("id", "model_spec")
VALUES ('default', 'openai/text-embedding-3-large')
ON CONFLICT ("id") DO NOTHING;

-- Default GLOBAL tool config for the implementer agent (all 4 workspace tools).
-- syncBuiltins() at gateway startup maintains this too; the seed keeps a
-- fresh DB correct even before the gateway's first boot.
INSERT INTO "agent_tool_configs" ("agent_role", "scope", "enabled_tools")
VALUES ('implementer', 'GLOBAL', ARRAY['readFile', 'writeFile', 'listDirectory', 'bash'])
ON CONFLICT DO NOTHING;

-- ── NOT NULL on array columns ────────────────────────────────────────────────
-- Prisma 7's generator emits `String[]` columns as nullable at the DB level
-- even though the client treats them as always-non-null — reinstate the
-- DB-level constraint to match the hand-written pre-consolidation DDL.
ALTER TABLE "teams"
  ALTER COLUMN "egress_allowlist" SET NOT NULL;

ALTER TABLE "workflow_shell_audit"
  ALTER COLUMN "egress_allowlist_snapshot" SET NOT NULL;

ALTER TABLE "agent_lessons"
  ALTER COLUMN "skills_active" SET NOT NULL;

ALTER TABLE "agent_tool_configs"
  ALTER COLUMN "enabled_tools" SET DEFAULT '{}',
  ALTER COLUMN "enabled_tools" SET NOT NULL;
