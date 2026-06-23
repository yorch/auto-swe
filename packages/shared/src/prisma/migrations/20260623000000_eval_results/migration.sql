-- Migration: eval_results
-- P0 of the evals feature (docs/evals-p0.md): capture the quality signals the
-- system already computes — gate pass/fail, review-network verdicts, and the
-- human PR merge/reject — as normalized EvalResult rows (one row per scorer).
-- Additive and best-effort; changes no existing behavior.

CREATE TYPE "EvalScoreType" AS ENUM ('BOOLEAN', 'NUMERIC', 'CATEGORICAL');
CREATE TYPE "EvalSignalSource" AS ENUM ('GATE', 'REVIEW', 'MERGE', 'JUDGE', 'TRAJECTORY');

CREATE TABLE "eval_results" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id"      UUID,
  "node_id"     TEXT,
  "case_id"     UUID,
  "agent_key"   TEXT,
  "source"      "EvalSignalSource" NOT NULL,
  "scorer"      TEXT NOT NULL,
  "score_type"  "EvalScoreType" NOT NULL,
  "value"       DOUBLE PRECISION NOT NULL,
  "passed"      BOOLEAN,
  "rationale"   TEXT,
  "judge_model" TEXT,
  "cost_usd"    DOUBLE PRECISION,
  "metadata"    JSONB,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "eval_results_run_id_idx" ON "eval_results"("run_id");
CREATE INDEX "eval_results_scorer_created_at_idx" ON "eval_results"("scorer", "created_at");
CREATE INDEX "eval_results_source_created_at_idx" ON "eval_results"("source", "created_at");

ALTER TABLE "eval_results"
  ADD CONSTRAINT "eval_results_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
