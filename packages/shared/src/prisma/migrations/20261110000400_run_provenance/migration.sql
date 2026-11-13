-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "initiated_by_id" UUID,
ADD COLUMN     "initiated_by_service_id" UUID,
ADD COLUMN     "rerun_of_run_id" UUID,
ADD COLUMN     "trigger" TEXT,
ADD COLUMN     "trigger_ref_id" TEXT;

-- CreateIndex
CREATE INDEX "workflow_runs_initiated_by_id_idx" ON "workflow_runs"("initiated_by_id");

-- CreateIndex
CREATE INDEX "workflow_runs_initiated_by_service_id_idx" ON "workflow_runs"("initiated_by_service_id");

-- CreateIndex
CREATE INDEX "workflow_runs_rerun_of_run_id_idx" ON "workflow_runs"("rerun_of_run_id");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_initiated_by_id_fkey" FOREIGN KEY ("initiated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_initiated_by_service_id_fkey" FOREIGN KEY ("initiated_by_service_id") REFERENCES "service_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_rerun_of_run_id_fkey" FOREIGN KEY ("rerun_of_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

