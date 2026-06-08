-- Migration: add is_active to skills table
--
-- Allows admins to disable a built-in skill without deleting it.
-- Inactive skills are excluded from agent system prompts at resolution time.
-- Built-in skills cannot be deleted; disabling via is_active is the
-- only supported way to suppress them.

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
