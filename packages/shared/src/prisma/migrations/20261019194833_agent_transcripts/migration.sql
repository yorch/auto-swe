-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "transcript_legal_hold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transcript_legal_hold_at" TIMESTAMPTZ,
ADD COLUMN     "transcript_legal_hold_by_id" TEXT,
ADD COLUMN     "transcript_legal_hold_reason" TEXT;

-- CreateTable
CREATE TABLE "agent_transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "assistant_message_id" UUID,
    "workflow_id" TEXT NOT NULL,
    "temporal_run_id" TEXT,
    "activity_type" TEXT NOT NULL,
    "spec_node_id" TEXT,
    "recording_id" TEXT,
    "step_attempt" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "agent_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runtime" TEXT NOT NULL DEFAULT 'ai-sdk',
    "status" TEXT NOT NULL DEFAULT 'open',
    "activity_outcome" TEXT,
    "model_call_count" INTEGER NOT NULL DEFAULT 0,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "team_id" UUID,
    "org_id" UUID,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "legal_hold_reason" TEXT,
    "legal_hold_by_id" TEXT,
    "legal_hold_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "agent_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_transcript_parts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transcript_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "artifact_id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "record_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_transcript_parts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_transcripts_run_id_idx" ON "agent_transcripts"("run_id");

-- CreateIndex
CREATE INDEX "agent_transcripts_workflow_id_temporal_run_id_idx" ON "agent_transcripts"("workflow_id", "temporal_run_id");

-- CreateIndex
CREATE INDEX "agent_transcripts_org_id_created_at_idx" ON "agent_transcripts"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_transcripts_team_id_created_at_idx" ON "agent_transcripts"("team_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_transcripts_created_at_idx" ON "agent_transcripts"("created_at");

-- CreateIndex
CREATE INDEX "agent_transcripts_status_updated_at_idx" ON "agent_transcripts"("status", "updated_at");

-- CreateIndex
CREATE INDEX "agent_transcript_parts_artifact_id_idx" ON "agent_transcript_parts"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_transcript_parts_transcript_id_seq_key" ON "agent_transcript_parts"("transcript_id", "seq");

-- AddForeignKey
ALTER TABLE "agent_transcripts" ADD CONSTRAINT "agent_transcripts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcripts" ADD CONSTRAINT "agent_transcripts_assistant_message_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "assistant_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcripts" ADD CONSTRAINT "agent_transcripts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcripts" ADD CONSTRAINT "agent_transcripts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcript_parts" ADD CONSTRAINT "agent_transcript_parts_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "agent_transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_transcript_parts" ADD CONSTRAINT "agent_transcript_parts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "workflow_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

