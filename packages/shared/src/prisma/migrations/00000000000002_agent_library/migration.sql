-- P1 WS1: first-class Agent library.
--
-- `agents` overlays the legacy per-role config tables (model_role_configs /
-- agent_skill_assignments / agent_tool_configs). Null override columns mean
-- "inherit from the legacy cascade for this key", so seeded SWE agents resolve
-- byte-identically to P0 behavior. `agent_skill_refs` attaches skills to an
-- agent with ordering.

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "workflow_template_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "model_spec" TEXT,
    "system_prompt" TEXT,
    "credential_id" UUID,
    "tool_keys" JSONB,
    "origin" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skill_refs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_skill_refs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agents_scope_team_id_idx" ON "agents"("scope", "team_id");

-- CreateIndex
CREATE INDEX "agents_scope_workflow_template_id_idx" ON "agents"("scope", "workflow_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_skill_refs_agent_id_skill_id_key" ON "agent_skill_refs"("agent_id", "skill_id");

-- Partial unique indexes (one row per (key, version) at a scope). Prisma can't
-- express `WHERE scope = …`, so they live here. Postgres treats NULL
-- discriminators as distinct, so the WHERE clause scopes each uniqueness.
CREATE UNIQUE INDEX "agents_key_version_global_uidx"
    ON "agents" ("key", "version")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agents_key_version_team_uidx"
    ON "agents" ("key", "version", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agents_key_version_template_uidx"
    ON "agents" ("key", "version", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skill_refs" ADD CONSTRAINT "agent_skill_refs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skill_refs" ADD CONSTRAINT "agent_skill_refs_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
