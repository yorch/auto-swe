-- ----------------------------------------------------------------------------
-- Custom DDL that Prisma's schema DSL cannot express. Applied after the
-- consolidated init that the Prisma generator produced.
-- ----------------------------------------------------------------------------

-- Raw pgvector HNSW index on memory_items.embedding. Prisma 7's schema DSL
-- cannot model HNSW/IVFFlat indexes, so it lives in its own migration kept
-- separate from `init`. Routine application is `yarn db:migrate` (deploy);
-- `prisma migrate dev` cannot see HNSW indexes and will try to re-drop this
-- one on the next unrelated schema change — see the project skill
-- `prisma-7-pgvector-hnsw-migrate-dev-drift` for the workflow.
CREATE INDEX IF NOT EXISTS "idx_memory_items_embedding" ON "memory_items"
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- ── Provider credentials (GLOBAL or TEAM only; no template scope) ────────────
ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_check"
    CHECK ("scope" IN ('GLOBAL', 'TEAM'));

CREATE UNIQUE INDEX "provider_credentials_global_unique"
    ON "provider_credentials" ("provider")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "provider_credentials_team_unique"
    ON "provider_credentials" ("provider", "team_id")
    WHERE "scope" = 'TEAM';

ALTER TABLE "provider_credentials"
    ADD CONSTRAINT "provider_credentials_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL)
    );

-- ── Agent library: one row per (key, version) at a scope ─────────────────────
-- Partial uniques per scope; Prisma can't express `WHERE scope = …`. Postgres
-- treats NULL discriminators as distinct, so each WHERE scopes its uniqueness.
CREATE UNIQUE INDEX "agents_key_version_global_uidx"
    ON "agents" ("key", "version")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agents_key_version_team_uidx"
    ON "agents" ("key", "version", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agents_key_version_template_uidx"
    ON "agents" ("key", "version", "workflow_template_id")
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

-- ── NOT NULL on array columns ────────────────────────────────────────────────
-- Prisma 7's generator emits `String[]` columns as nullable at the DB level
-- even though the client treats them as always-non-null — reinstate the
-- DB-level constraint to match the hand-written pre-consolidation DDL.
ALTER TABLE "teams"
  ALTER COLUMN "egress_allowlist" SET NOT NULL;

ALTER TABLE "workflow_shell_audit"
  ALTER COLUMN "egress_allowlist_snapshot" SET NOT NULL;

ALTER TABLE "memory_items"
  ALTER COLUMN "skills_active" SET NOT NULL;
