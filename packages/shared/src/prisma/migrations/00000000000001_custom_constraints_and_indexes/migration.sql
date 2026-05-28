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

-- Partial unique indexes for `ConfigScope` cascade (Prisma DSL can't express
-- WHERE clauses on unique indexes, so they live here). At most one row per
-- (role, scope-key) — NULLs are ignored on the inactive scope's discriminator.
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
-- A check constraint enforces this so a bad insert from raw SQL still fails.
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
-- (or null) for each scope. Belt-and-suspenders alongside the partial
-- unique indexes above.
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

-- Singleton enforcement: the `id` column must always be the literal 'default'.
-- The Prisma model uses `@default("default")` so writes through the client
-- always produce the right value; this check is belt-and-suspenders against
-- raw SQL inserts.
ALTER TABLE "embedding_configs"
    ADD CONSTRAINT "embedding_configs_singleton_check"
    CHECK ("id" = 'default');

-- Seed the default row for existing deployments so they keep working
-- immediately after the Phase-6 cutover (worker now reads this row instead
-- of the EMBEDDING_MODEL env var). New deployments will override via the
-- dashboard before bringing up the worker.
INSERT INTO "embedding_configs" ("id", "model_spec")
VALUES ('default', 'openai/text-embedding-3-large')
ON CONFLICT ("id") DO NOTHING;

-- Preserve NOT NULL on String[] columns that the pre-consolidation migrations
-- added explicitly. Prisma 7's generator emits these columns as nullable at
-- the DB level even though the Prisma client treats `String[]` as
-- always-non-null at the TypeScript level — so reinstate the DB-level
-- constraint here to match the pre-consolidation behavior.
ALTER TABLE "teams"
  ALTER COLUMN "egress_allowlist" SET NOT NULL;

ALTER TABLE "workflow_shell_audit"
  ALTER COLUMN "egress_allowlist_snapshot" SET NOT NULL;
