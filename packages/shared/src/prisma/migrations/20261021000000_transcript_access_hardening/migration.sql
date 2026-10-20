-- AlterTable
ALTER TABLE "workflow_artifacts" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ready';

-- CreateTable
CREATE TABLE "transcript_access_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "transcript_id" UUID,
    "run_id" UUID,
    "params" JSONB,
    "outcome" TEXT NOT NULL DEFAULT 'started',
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "transcript_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcript_access_log_created_at_idx" ON "transcript_access_log"("created_at");

-- CreateIndex
CREATE INDEX "transcript_access_log_transcript_id_created_at_idx" ON "transcript_access_log"("transcript_id", "created_at");

-- CreateIndex
CREATE INDEX "transcript_access_log_actor_id_created_at_idx" ON "transcript_access_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "transcript_access_log_run_id_created_at_idx" ON "transcript_access_log"("run_id", "created_at");

