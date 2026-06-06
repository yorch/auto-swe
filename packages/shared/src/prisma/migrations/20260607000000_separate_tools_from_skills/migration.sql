-- Separate tool access control from skills (prompt fragments).
-- Skills are now purely prompt-fragment instructions.
-- Tool configuration moves to the new agent_tool_configs table.

-- Step 1: Delete the 4 built-in TOOL-type skills and their assignments
-- (assignments cascade via ON DELETE CASCADE on the FK)
DELETE FROM "skills" WHERE "id" IN (
  '00000000-0000-0000-0001-000000000001',
  '00000000-0000-0000-0001-000000000002',
  '00000000-0000-0000-0001-000000000003',
  '00000000-0000-0000-0001-000000000004'
);

-- Step 2: Drop type/toolKey from skills; make prompt_text NOT NULL
-- First set any NULL prompt_text rows to empty string (shouldn't exist, but defensive)
UPDATE "skills" SET "prompt_text" = '' WHERE "prompt_text" IS NULL;

ALTER TABLE "skills"
  DROP COLUMN IF EXISTS "type",
  DROP COLUMN IF EXISTS "tool_key",
  ALTER COLUMN "prompt_text" SET NOT NULL;

-- Step 3: Drop SkillType enum (only after column dropped)
DROP TYPE IF EXISTS "SkillType";

-- Step 4: Create agent_tool_configs table
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
            ("scope" = 'GLOBAL' AND "team_id" IS NULL AND "workflow_template_id" IS NULL)
            OR ("scope" = 'TEAM' AND "team_id" IS NOT NULL AND "workflow_template_id" IS NULL)
            OR ("scope" = 'WORKFLOW_TEMPLATE' AND "team_id" IS NULL AND "workflow_template_id" IS NOT NULL)
        )
);

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

-- Step 5: Seed default GLOBAL tool config for IMPLEMENTER (all 4 tools enabled)
INSERT INTO "agent_tool_configs" ("agent_role", "scope", "enabled_tools")
VALUES ('IMPLEMENTER', 'GLOBAL', ARRAY['readFile','writeFile','listDirectory','bash'])
ON CONFLICT DO NOTHING;
