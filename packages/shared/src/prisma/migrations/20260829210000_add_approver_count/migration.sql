-- AlterTable
ALTER TABLE "workflow_human_steps" ADD COLUMN "required_approvers" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "human_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "step_id" UUID NOT NULL,
    "resolved_by" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "value" JSONB,
    "resolved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "human_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "human_approvals_step_id_resolved_by_key" ON "human_approvals"("step_id", "resolved_by");

-- CreateIndex
CREATE INDEX "human_approvals_step_id_idx" ON "human_approvals"("step_id");

-- AddForeignKey
ALTER TABLE "human_approvals" ADD CONSTRAINT "human_approvals_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "workflow_human_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
