-- Attribute each agent trace to the workflow-spec node (and fan-out branch) it ran
-- for. All three columns are nullable: traces written before this migration, and
-- those from activities the interpreter did not dispatch, carry NULL and the run
-- viewer falls back to matching the activity name.
ALTER TABLE "agent_traces" ADD COLUMN "spec_node_id" TEXT;
ALTER TABLE "agent_traces" ADD COLUMN "recording_id" TEXT;
ALTER TABLE "agent_traces" ADD COLUMN "step_attempt" INTEGER;

CREATE INDEX "agent_traces_run_id_recording_id_idx" ON "agent_traces"("run_id", "recording_id");
