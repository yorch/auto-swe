ALTER TABLE "workflow_steps"
  ADD COLUMN "spec_node_id" TEXT,
  ADD COLUMN "node_type" TEXT,
  ADD COLUMN "step_name" TEXT;
