-- CreateEnum
CREATE TYPE "ConfigScope" AS ENUM ('GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE');

-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('IMPLEMENTER', 'REVIEWER', 'PLANNER', 'SECURITY_REVIEW', 'VALIDATE_CONTEXT', 'COMMIT_TO_MEMORY');

-- CreateEnum
CREATE TYPE "ConfigAuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "api_base" TEXT,
    "api_key_ciphertext" BYTEA NOT NULL,
    "api_key_nonce" BYTEA NOT NULL,
    "api_key_auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "last_four" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_role_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" "AgentRole" NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "workflow_template_id" UUID,
    "model_spec" TEXT NOT NULL,
    "credential_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_role_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "ConfigAuditAction" NOT NULL,
    "actor_id" UUID,
    "before_json" JSONB,
    "after_json" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_credentials_provider_scope_team_id_idx" ON "provider_credentials"("provider", "scope", "team_id");

-- CreateIndex
CREATE INDEX "model_role_configs_scope_team_id_idx" ON "model_role_configs"("scope", "team_id");

-- CreateIndex
CREATE INDEX "model_role_configs_scope_workflow_template_id_idx" ON "model_role_configs"("scope", "workflow_template_id");

-- CreateIndex
CREATE INDEX "config_audit_log_entity_type_entity_id_idx" ON "config_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "config_audit_log_actor_id_idx" ON "config_audit_log"("actor_id");

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
