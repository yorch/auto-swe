-- CreateTable
CREATE TABLE "autonomy_decisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "actor_id" UUID,
    "policy_name" TEXT,
    "risk_class" TEXT,
    "required_approvers" INTEGER DEFAULT 1,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "autonomy_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autonomy_decisions_run_id_idx" ON "autonomy_decisions"("run_id");

-- AddForeignKey
ALTER TABLE "autonomy_decisions" ADD CONSTRAINT "autonomy_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
