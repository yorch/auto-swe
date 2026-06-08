-- Migration: Close agent/skills gaps
--
-- 1. Add skill-only sub-roles to AgentRole enum (no ModelRoleConfig required).
-- 2. Add is_verified and is_active to skills table.
-- 3. Add skills_active to agent_lessons (tracks which skills were active when a lesson is written).

-- 1. Extend AgentRole enum with reviewer sub-roles + decomposer
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'SECURITY_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'DOMAIN_LOGIC_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'PERFORMANCE_REVIEWER';
ALTER TYPE "AgentRole" ADD VALUE IF NOT EXISTS 'DECOMPOSER';

-- 2. Add is_verified and is_active columns to skills
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "is_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "is_active"   BOOLEAN NOT NULL DEFAULT true;

-- Mark all existing built-in skills as verified
UPDATE "skills" SET "is_verified" = true WHERE "is_built_in" = true;

-- 3. Add skills_active column to agent_lessons
ALTER TABLE "agent_lessons" ADD COLUMN IF NOT EXISTS "skills_active" TEXT[] NOT NULL DEFAULT '{}';
