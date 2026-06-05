-- CreateEnum
CREATE TYPE "HumanStepKind" AS ENUM ('APPROVAL', 'DECISION', 'INPUT', 'REVIEW');

-- CreateEnum
CREATE TYPE "HumanStepStatus" AS ENUM ('PENDING', 'RESOLVED', 'TIMED_OUT', 'CANCELLED');

-- CreateTable
CREATE TABLE "workflow_human_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "signal_name" TEXT NOT NULL,
    "kind" "HumanStepKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "context" JSONB,
    "options" JSONB,
    "fields" JSONB,
    "status" "HumanStepStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "payload" JSONB,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "workflow_human_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_human_steps_run_id_idx" ON "workflow_human_steps"("run_id");

-- CreateIndex
CREATE INDEX "workflow_human_steps_status_idx" ON "workflow_human_steps"("status");

-- AddForeignKey
ALTER TABLE "workflow_human_steps" ADD CONSTRAINT "workflow_human_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_human_steps" ADD CONSTRAINT "workflow_human_steps_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Idempotency guard: prevents duplicate PENDING rows for the same (run_id, node_id) pair
-- while allowing multiple historical resolved/cancelled rows (e.g. re-execution in retry loops).
CREATE UNIQUE INDEX workflow_human_steps_pending_unique
  ON workflow_human_steps (run_id, node_id)
  WHERE status = 'PENDING';
