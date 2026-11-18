-- AlterTable
ALTER TABLE "workflow_human_steps" ADD COLUMN     "last_nudged_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "failure_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_run_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "assignee_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failure_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_budget_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "team_budget_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "failure_assignments_workflow_run_id_key" ON "failure_assignments"("workflow_run_id");

-- CreateIndex
CREATE INDEX "failure_assignments_team_id_idx" ON "failure_assignments"("team_id");

-- CreateIndex
CREATE INDEX "failure_assignments_assignee_id_idx" ON "failure_assignments"("assignee_id");

-- CreateIndex
CREATE INDEX "team_budget_requests_team_id_resolved_at_idx" ON "team_budget_requests"("team_id", "resolved_at");

-- AddForeignKey
ALTER TABLE "failure_assignments" ADD CONSTRAINT "failure_assignments_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_assignments" ADD CONSTRAINT "failure_assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_assignments" ADD CONSTRAINT "failure_assignments_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_assignments" ADD CONSTRAINT "failure_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_budget_requests" ADD CONSTRAINT "team_budget_requests_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_budget_requests" ADD CONSTRAINT "team_budget_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written: DDL Prisma cannot express.
-- At most one pending budget request per team; saving the cap resolves it, which frees the slot.
CREATE UNIQUE INDEX "team_budget_requests_one_pending_per_team_idx" ON "team_budget_requests"("team_id") WHERE "resolved_at" IS NULL;

-- A reason is 1 to 500 characters, whatever path writes it.
ALTER TABLE "team_budget_requests" ADD CONSTRAINT "team_budget_requests_reason_length_check" CHECK (char_length("reason") BETWEEN 1 AND 500);

