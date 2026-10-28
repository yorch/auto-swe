-- The stack an eval case's reference and candidate run on: one of node, python, jvm, go, or null
-- (node, the image every case ran on before this column). The worker maps it to a pinned base image,
-- so a case can name a toolchain but never an arbitrary image. Validated at the API and again where
-- the worker resolves it; a value outside the set fails the case instead of falling back.

-- AlterTable
ALTER TABLE "eval_cases" ADD COLUMN     "stack" TEXT;
