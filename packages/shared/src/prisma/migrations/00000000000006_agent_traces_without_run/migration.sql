-- Workflows that keep no workflow_runs row (workflow authoring, scheduled evals,
-- lesson consolidation, repo-access sync, epic planning) used to have their
-- traces dropped, because run_id was required. Their LLM spend was recorded
-- nowhere. Traces now carry the Temporal workflow ID, and run_id is set only
-- when a run exists.
--
-- Both statements are catalog-only: no table rewrite, no scan. workflow_id is
-- deliberately left nullable and is not backfilled. Every existing row has a
-- run_id, so readers fall back to the run's workflow_id; a backfill would
-- rewrite the largest append-heavy table inside the gateway's boot-time
-- migrate, and NOT NULL would reject inserts from a worker image that predates
-- this column for as long as a rolling deploy keeps one running.
ALTER TABLE "agent_traces" ADD COLUMN "workflow_id" TEXT;

ALTER TABLE "agent_traces" ALTER COLUMN "run_id" DROP NOT NULL;
