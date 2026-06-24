-- Migration: evals_p3_quarantine
-- P3 (docs/evals-p3.md): EvalCase.quarantined for the golden-set re-validation loop.

-- AlterTable
ALTER TABLE "eval_cases" ADD COLUMN     "quarantined" BOOLEAN NOT NULL DEFAULT false;

