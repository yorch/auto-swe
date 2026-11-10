-- CreateTable
CREATE TABLE "run_effects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "workflow_id" TEXT NOT NULL,
    "spec_node_id" TEXT,
    "agent_key" TEXT,
    "kind" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "status" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "input_digest" TEXT,
    "detail" JSONB,
    "error" TEXT,
    "team_id" UUID,
    "org_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_effects_run_id_created_at_idx" ON "run_effects"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "run_effects_workflow_id_created_at_idx" ON "run_effects"("workflow_id", "created_at");

-- CreateIndex
CREATE INDEX "run_effects_created_at_idx" ON "run_effects"("created_at");

-- AddForeignKey
ALTER TABLE "run_effects" ADD CONSTRAINT "run_effects_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

