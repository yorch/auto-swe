-- Migration: Skills system and AgentSkillAssignment
-- Adds the `skills` and `agent_skill_assignments` tables.
-- Partial unique indexes enforce one assignment per (role, skill, scope-key),
-- mirroring the pattern used by model_role_configs.

-- CreateEnum (SkillType)
CREATE TYPE "SkillType" AS ENUM ('TOOL', 'PROMPT_FRAGMENT');

-- CreateTable: skills
CREATE TABLE "skills" (
    "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"        TEXT         NOT NULL,
    "description" TEXT,
    "type"        "SkillType"  NOT NULL,
    "tool_key"    TEXT,
    "prompt_text" TEXT,
    "is_built_in" BOOLEAN      NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

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
        FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates" ("id") ON DELETE CASCADE
);

-- Indexes for lookup by role+scope
CREATE INDEX "agent_skill_assignments_role_scope_team_idx"
    ON "agent_skill_assignments" ("agent_role", "scope", "team_id");

CREATE INDEX "agent_skill_assignments_role_scope_template_idx"
    ON "agent_skill_assignments" ("agent_role", "scope", "workflow_template_id");

-- Partial unique indexes: one assignment per (role, skill) within each scope-key.
-- Prisma DSL cannot express WHERE clauses on unique indexes.
CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_global_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id")
    WHERE "scope" = 'GLOBAL';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_team_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "team_id")
    WHERE "scope" = 'TEAM';

CREATE UNIQUE INDEX "agent_skill_assignments_role_skill_template_uidx"
    ON "agent_skill_assignments" ("agent_role", "skill_id", "workflow_template_id")
    WHERE "scope" = 'WORKFLOW_TEMPLATE';

-- Scope-discriminator integrity check (mirrors model_role_configs pattern)
ALTER TABLE "agent_skill_assignments"
    ADD CONSTRAINT "agent_skill_assignments_scope_keys_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
        OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL AND "workflow_template_id" IS NOT NULL)
    );

-- Seed the 4 built-in tool skills with deterministic UUIDs
INSERT INTO "skills" ("id", "name", "description", "type", "tool_key", "is_built_in")
VALUES
  ('00000000-0000-0000-0001-000000000001', 'Read File',      'Read file contents from the workspace',          'TOOL', 'readFile',      true),
  ('00000000-0000-0000-0001-000000000002', 'Write File',     'Write or update files in the workspace',         'TOOL', 'writeFile',     true),
  ('00000000-0000-0000-0001-000000000003', 'List Directory', 'List directory contents in the workspace',       'TOOL', 'listDirectory', true),
  ('00000000-0000-0000-0001-000000000004', 'Bash',           'Execute shell commands in the workspace',        'TOOL', 'bash',          true)
ON CONFLICT ("id") DO NOTHING;

-- Assign all 4 built-in tools to IMPLEMENTER at GLOBAL scope
INSERT INTO "agent_skill_assignments" ("agent_role", "skill_id", "scope", "sort_order")
VALUES
  ('IMPLEMENTER', '00000000-0000-0000-0001-000000000001', 'GLOBAL', 0),
  ('IMPLEMENTER', '00000000-0000-0000-0001-000000000002', 'GLOBAL', 1),
  ('IMPLEMENTER', '00000000-0000-0000-0001-000000000003', 'GLOBAL', 2),
  ('IMPLEMENTER', '00000000-0000-0000-0001-000000000004', 'GLOBAL', 3)
ON CONFLICT DO NOTHING;
