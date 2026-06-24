-- Migration: evals_p1_datasets
-- P1 of the evals feature (docs/evals-p1.md): the frozen-benchmark offline
-- harness data model — EvalDataset / EvalCase / EvalRun — plus EvalResult
-- gaining the case + harness-run foreign keys. Additive.

-- AlterTable
ALTER TABLE "eval_results" ADD COLUMN     "eval_run_id" UUID;

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

-- CreateIndex
CREATE INDEX "eval_datasets_scope_team_id_idx" ON "eval_datasets"("scope", "team_id");

-- CreateIndex
CREATE INDEX "eval_datasets_slug_idx" ON "eval_datasets"("slug");

-- CreateIndex
CREATE INDEX "eval_cases_dataset_id_idx" ON "eval_cases"("dataset_id");

-- CreateIndex
CREATE INDEX "eval_runs_dataset_id_started_at_idx" ON "eval_runs"("dataset_id", "started_at");

-- CreateIndex
CREATE INDEX "eval_results_case_id_idx" ON "eval_results"("case_id");

-- CreateIndex
CREATE INDEX "eval_results_eval_run_id_idx" ON "eval_results"("eval_run_id");

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "eval_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "eval_datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

