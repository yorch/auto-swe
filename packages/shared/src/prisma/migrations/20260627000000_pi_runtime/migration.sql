-- `pi` joins the runtimes an Agent version may name (`IMPLEMENTER_RUNTIMES`).
ALTER TABLE "agents" DROP CONSTRAINT "agents_runtime_check";
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_runtime_check"
  CHECK ("runtime" IS NULL OR "runtime" IN ('mastra', 'claude-code', 'pi'));
