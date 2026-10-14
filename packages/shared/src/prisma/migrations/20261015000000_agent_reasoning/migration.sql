-- How hard an Agent version's model reasons before it answers (`REASONING_LEVELS`). Null = no
-- opinion: the model's own default, or the level of the agent it inherits its model from.
ALTER TABLE "agents" ADD COLUMN "reasoning" TEXT;
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_reasoning_check"
  CHECK ("reasoning" IS NULL OR "reasoning" IN ('off', 'low', 'medium', 'high'));
