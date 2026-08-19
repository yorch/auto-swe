-- ----------------------------------------------------------------------------
-- Definition-driven configuration registry.
--
-- `config_settings` holds one JSON override per (key, scope) so a new operator
-- knob costs a definition in `@auto-swe/shared/config/registry` rather than a
-- migration. `config_permissions` records who may write which keys and where.
--
-- Hand-written rather than generated: both tables need CHECK constraints and
-- partial unique indexes the Prisma DSL cannot express, and this file is
-- appended after the two existing migrations rather than editing either of
-- them (they are already applied everywhere). See the project skill
-- `prisma-pgvector-hnsw` before running any `prisma migrate` command here.
-- ----------------------------------------------------------------------------

-- ── config_settings ─────────────────────────────────────────────────────────
CREATE TABLE "config_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "org_id" UUID,
    "channel_id" UUID,
    "workflow_template_id" UUID,
    "value" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "config_settings_key_idx" ON "config_settings" ("key");
CREATE INDEX "config_settings_scope_team_id_idx" ON "config_settings" ("scope", "team_id");
CREATE INDEX "config_settings_scope_org_id_idx" ON "config_settings" ("scope", "org_id");
CREATE INDEX "config_settings_scope_channel_id_idx" ON "config_settings" ("scope", "channel_id");
CREATE INDEX "config_settings_scope_workflow_template_id_idx" ON "config_settings" ("scope", "workflow_template_id");
CREATE INDEX "config_settings_team_id_idx" ON "config_settings" ("team_id");
CREATE INDEX "config_settings_org_id_idx" ON "config_settings" ("org_id");
CREATE INDEX "config_settings_channel_id_idx" ON "config_settings" ("channel_id");
CREATE INDEX "config_settings_workflow_template_id_idx" ON "config_settings" ("workflow_template_id");

ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "slack_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly the scope column for the row's scope may be set — same shape as the
-- `agents_scope_keys_check` constraint, so a TEAM row can never carry an org id.
ALTER TABLE "config_settings" ADD CONSTRAINT "config_settings_scope_keys_check" CHECK (
    ("scope" = 'GLOBAL'            AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'ORGANIZATION'      AND "org_id" IS NOT NULL AND "team_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "org_id" IS NULL AND "channel_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'CHANNEL'           AND "channel_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "workflow_template_id" IS NULL)
 OR ("scope" = 'WORKFLOW_TEMPLATE' AND "workflow_template_id" IS NOT NULL AND "team_id" IS NULL AND "org_id" IS NULL AND "channel_id" IS NULL)
);

-- One override per key per scope instance. Partial per scope because Prisma
-- cannot express `WHERE scope = …` in a unique index — the same reason
-- `Agent` and `ProviderCredential` GLOBAL rows use findFirst-then-create
-- instead of upsert.
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

-- ── config_permissions ──────────────────────────────────────────────────────
CREATE TABLE "config_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key_pattern" TEXT NOT NULL,
    "user_id" UUID,
    "role" "Role",
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "org_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_permissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "config_permissions_user_id_idx" ON "config_permissions" ("user_id");
CREATE INDEX "config_permissions_role_idx" ON "config_permissions" ("role");
CREATE INDEX "config_permissions_team_id_idx" ON "config_permissions" ("team_id");
CREATE INDEX "config_permissions_org_id_idx" ON "config_permissions" ("org_id");

ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A grant names exactly one grantee: a specific user, or every holder of a role.
ALTER TABLE "config_permissions" ADD CONSTRAINT "config_permissions_grantee_check" CHECK (
    ("user_id" IS NOT NULL AND "role" IS NULL)
 OR ("user_id" IS NULL AND "role" IS NOT NULL)
);

-- Grants are only meaningful down to a tenant boundary: a CHANNEL- or
-- TEMPLATE-scoped grant would be narrower than the thing an operator actually
-- administers, so authority is expressed at GLOBAL, ORGANIZATION, or TEAM and
-- covers everything beneath it.
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

-- ── Run pinning ─────────────────────────────────────────────────────────────
-- Snapshot of run-pinned registry settings taken at run start, alongside the
-- existing agent_versions pin.
ALTER TABLE "workflow_runs" ADD COLUMN "pinned_settings" JSONB;
