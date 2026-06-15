-- P1 WS2: sub-reviewer/decomposer model inheritance. When `model_spec` is null
-- and `inherits_model_from` names a parent agent key, resolveAgent binds that
-- parent's model. Replaces the implicit SkillOnlyRole → parent-role inheritance.

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "inherits_model_from" TEXT;
