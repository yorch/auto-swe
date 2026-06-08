-- Migration: Skills, agent tool config, and AgentRole skill-only sub-roles
--
-- Skills are pure prompt-fragment instructions injected into an agent's system
-- prompt. Tool access is governed by a separate AgentToolConfig table.
-- Skill-only sub-roles let review-network personas carry skills without
-- needing a full ModelRoleConfig entry.

-- Extend AgentRole with skill-only reviewer sub-roles and decomposer
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'SECURITY_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'DOMAIN_LOGIC_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'PERFORMANCE_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'DECOMPOSER';

-- CreateTable: skills
CREATE TABLE "skills" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "name"        TEXT        NOT NULL,
    "description" TEXT,
    "prompt_text" TEXT        NOT NULL,
    "is_built_in" BOOLEAN     NOT NULL DEFAULT false,
    "is_verified" BOOLEAN     NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable: agent_skill_assignments
CREATE TABLE "agent_skill_assignments" (
    "id"                   UUID          NOT NULL DEFAULT gen_random_uuid(),
    "agent_role"           "AgentRole"   NOT NULL,
    "skill_id"             UUID          NOT NULL,
    "scope"                "ConfigScope" NOT NULL,
    "team_id"              UUID,
    "workflow_template_id" UUID,
    "sort_order"           INTEGER       NOT NULL DEFAULT 0,
    "created_at"           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT "agent_skill_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_skill_assignments_skill_fk"
        FOREIGN KEY ("skill_id") REFERENCES "skills" ("id") ON DELETE CASCADE,
    CONSTRAINT "agent_skill_assignments_team_fk"
        FOREIGN KEY ("team_id") REFERENCES "teams" ("id") ON DELETE CASCADE,
    CONSTRAINT "agent_skill_assignments_template_fk"
        FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates" ("id") ON DELETE CASCADE,
    CONSTRAINT "agent_skill_assignments_scope_keys_check"
        CHECK (
            ("scope" = 'GLOBAL'               AND "team_id" IS NULL     AND "workflow_template_id" IS NULL)
            OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
            OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL     AND "workflow_template_id" IS NOT NULL)
        )
);

CREATE INDEX "agent_skill_assignments_role_scope_team_idx"
    ON "agent_skill_assignments" ("agent_role", "scope", "team_id");

CREATE INDEX "agent_skill_assignments_role_scope_template_idx"
    ON "agent_skill_assignments" ("agent_role", "scope", "workflow_template_id");

-- Partial unique indexes: one assignment per (role, skill) within each scope-key
CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_global_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_team_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_template_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- CreateTable: agent_tool_configs
CREATE TABLE "agent_tool_configs" (
    "id"                   UUID          NOT NULL DEFAULT gen_random_uuid(),
    "agent_role"           "AgentRole"   NOT NULL,
    "scope"                "ConfigScope" NOT NULL,
    "team_id"              UUID,
    "workflow_template_id" UUID,
    "enabled_tools"        TEXT[]        NOT NULL DEFAULT '{}',
    "created_at"           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    "updated_at"           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT "agent_tool_configs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_tool_configs_team_fk"
        FOREIGN KEY ("team_id") REFERENCES "teams" ("id") ON DELETE CASCADE,
    CONSTRAINT "agent_tool_configs_template_fk"
        FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates" ("id") ON DELETE CASCADE,
    CONSTRAINT "agent_tool_configs_scope_keys_check"
        CHECK (
            ("scope" = 'GLOBAL'               AND "team_id" IS NULL     AND "workflow_template_id" IS NULL)
            OR ("scope" = 'TEAM'              AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
            OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL     AND "workflow_template_id" IS NOT NULL)
        ),
    CONSTRAINT "agent_tool_configs_tools_nonempty_check"
        CHECK (cardinality("enabled_tools") >= 1)
);

CREATE INDEX "agent_tool_configs_role_scope_team_idx"
    ON "agent_tool_configs" ("agent_role", "scope", "team_id");

CREATE INDEX "agent_tool_configs_role_scope_template_idx"
    ON "agent_tool_configs" ("agent_role", "scope", "workflow_template_id");

-- Partial unique indexes: one tool config per role per scope-key
CREATE UNIQUE INDEX "agent_tool_configs_role_global_uidx"
    ON "agent_tool_configs" ("agent_role")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agent_tool_configs_role_team_uidx"
    ON "agent_tool_configs" ("agent_role", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agent_tool_configs_role_template_uidx"
    ON "agent_tool_configs" ("agent_role", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- Track which skills were active when each lesson was written
ALTER TABLE "agent_lessons" ADD COLUMN IF NOT EXISTS "skills_active" TEXT[] NOT NULL DEFAULT '{}';
