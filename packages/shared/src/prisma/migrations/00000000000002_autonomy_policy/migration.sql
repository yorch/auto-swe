-- ----------------------------------------------------------------------------
-- Phase 3 governance: autonomy policies for conditional auto-publish vs.
-- human approval. Policies may be attached to a specific workflow template or
-- to a team as the default for all templates owned by that team. A single
-- seeded global default (team_id and template_id both NULL) provides the
-- fallback when no tenant-specific policy exists.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "autonomy_policies" (
    "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "team_id"     UUID NULL REFERENCES "teams"("id") ON DELETE CASCADE,
    "template_id" UUID NULL REFERENCES "workflow_templates"("id") ON DELETE CASCADE,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "is_default"  BOOLEAN NOT NULL DEFAULT FALSE,
    -- No DB default for `rules`: the application (Prisma) always sets it, and
    -- a redundant default in DDL can hide the fact that a create path forgot to
    -- supply the field.
    "rules"       JSONB NOT NULL,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_autonomy_policies_team_id" ON "autonomy_policies"("team_id");
CREATE INDEX IF NOT EXISTS "idx_autonomy_policies_template_id" ON "autonomy_policies"("template_id");

-- At most one team default policy per team (template_id must be NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_team_default_uidx"
    ON "autonomy_policies"("team_id")
    WHERE "is_default" = TRUE AND "template_id" IS NULL;

-- At most one global default policy (both team_id and template_id NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "autonomy_policies_global_default_uidx"
    ON "autonomy_policies"("is_default")
    WHERE "is_default" = TRUE AND "team_id" IS NULL AND "template_id" IS NULL;
