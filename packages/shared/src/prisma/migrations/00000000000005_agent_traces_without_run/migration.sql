-- Workflows that keep no workflow_runs row (workflow authoring, scheduled evals,
-- lesson consolidation, repo-access sync, epic planning) used to have their
-- traces dropped, because run_id was required. Their LLM spend was recorded
-- nowhere. Traces now carry the Temporal workflow ID instead, and run_id is
-- set only when a run exists.
ALTER TABLE "agent_traces" ADD COLUMN "workflow_id" TEXT;

UPDATE "agent_traces" t
SET "workflow_id" = r."workflow_id"
FROM "workflow_runs" r
WHERE t."run_id" = r."id";

ALTER TABLE "agent_traces" ALTER COLUMN "workflow_id" SET NOT NULL;

ALTER TABLE "agent_traces" ALTER COLUMN "run_id" DROP NOT NULL;

CREATE INDEX "agent_traces_workflow_id_idx" ON "agent_traces"("workflow_id");

-- Supports the cross-run usage report, which scans a time window.
CREATE INDEX "agent_traces_created_at_idx" ON "agent_traces"("created_at");
