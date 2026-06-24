-- Migration: evals_assert_source
-- Add ASSERT to EvalSignalSource so assert scorers aren't conflated with gates.

-- AlterEnum
ALTER TYPE "EvalSignalSource" ADD VALUE 'ASSERT';


