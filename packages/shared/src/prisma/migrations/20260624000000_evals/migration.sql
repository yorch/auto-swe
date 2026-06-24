-- Evals feature — signal capture (P0) + offline-harness data model (P1) +
-- judge rubrics (P2) + golden-set quarantine (P3).
--
-- Adds the EvalScoreType / EvalSignalSource enums and the eval_results,
-- eval_datasets, eval_cases, eval_runs, and eval_rubrics tables. Purely
-- additive — it creates new objects and touches no existing table.
--
-- Authored as one incremental migration on top of main's chain (matching main's
-- incremental-migration approach). Generated via `prisma migrate diff
-- --from-config-datasource --to-schema --script` against a DB with main's chain
-- applied, then trimmed to the eval-only DDL: the raw diff also surfaced
-- pre-existing drift between main's hand-written migrations and schema.prisma
-- (the pgvector HNSW index, some FK redefinitions, a knowledge_base_config
-- default) which is unrelated to this feature and intentionally excluded.

-- CreateEnum
CREATE TYPE "EvalScoreType" AS ENUM ('BOOLEAN', 'NUMERIC', 'CATEGORICAL');

-- CreateEnum
CREATE TYPE "EvalSignalSource" AS ENUM ('GATE', 'ASSERT', 'REVIEW', 'MERGE', 'JUDGE', 'TRAJECTORY');

-- CreateTable
CREATE TABLE "eval_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "node_id" TEXT,
    "case_id" UUID,
    "eval_run_id" UUID,
    "agent_key" TEXT,
    "source" "EvalSignalSource" NOT NULL,
    "scorer" TEXT NOT NULL,
    "score_type" "EvalScoreType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "passed" BOOLEAN,
    "rationale" TEXT,
    "judge_model" TEXT,
    "cost_usd" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_datasets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL DEFAULT 'GLOBAL',
    "team_id" UUID,
    "org_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_cases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dataset_id" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "repo_url" TEXT NOT NULL,
    "baseline_sha" TEXT NOT NULL,
    "golden_test" TEXT NOT NULL,
    "reference" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "flake_screened" BOOLEAN NOT NULL DEFAULT false,
    "flake_runs" INTEGER NOT NULL DEFAULT 0,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "source_run_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dataset_id" UUID NOT NULL,
    "candidate_ref" TEXT NOT NULL,
    "baseline_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "summary" JSONB,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_rubrics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL DEFAULT 'GLOBAL',
    "team_id" UUID,
    "org_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "prompt_text" TEXT NOT NULL,
    "scale" TEXT NOT NULL DEFAULT '0..1',
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_rubrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eval_results_run_id_idx" ON "eval_results"("run_id");

-- CreateIndex
CREATE INDEX "eval_results_case_id_idx" ON "eval_results"("case_id");

-- CreateIndex
CREATE INDEX "eval_results_eval_run_id_idx" ON "eval_results"("eval_run_id");

-- CreateIndex
CREATE INDEX "eval_results_scorer_created_at_idx" ON "eval_results"("scorer", "created_at");

-- CreateIndex
CREATE INDEX "eval_results_source_created_at_idx" ON "eval_results"("source", "created_at");

-- CreateIndex
CREATE INDEX "eval_datasets_scope_team_id_idx" ON "eval_datasets"("scope", "team_id");

-- CreateIndex
CREATE INDEX "eval_datasets_slug_idx" ON "eval_datasets"("slug");

-- CreateIndex
CREATE INDEX "eval_cases_dataset_id_idx" ON "eval_cases"("dataset_id");

-- CreateIndex
CREATE INDEX "eval_runs_dataset_id_started_at_idx" ON "eval_runs"("dataset_id", "started_at");

-- CreateIndex
CREATE INDEX "eval_rubrics_scope_slug_idx" ON "eval_rubrics"("scope", "slug");

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "eval_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
