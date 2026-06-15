-- P1 WS3: run-start Agent-version snapshot. Stores a { agentKey: version } map
-- of the active GLOBAL Agent versions at run start so resolveAgent pins them for
-- the life of the run (in-flight runs are unaffected by later Agent edits).

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN "agent_versions" JSONB;
