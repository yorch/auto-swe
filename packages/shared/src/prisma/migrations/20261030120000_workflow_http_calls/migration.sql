-- CreateTable
CREATE TABLE "workflow_http_calls" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "workflow_id" TEXT NOT NULL,
    "temporal_run_id" TEXT,
    "activity_type" TEXT,
    "spec_node_id" TEXT,
    "recording_id" TEXT,
    "step_attempt" INTEGER,
    "attempt" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "path" TEXT NOT NULL,
    "status" INTEGER,
    "duration_ms" INTEGER,
    "request_bytes" INTEGER,
    "response_bytes" INTEGER,
    "error" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "block_reason" TEXT,
    "request_body" TEXT,
    "response_body" TEXT,
    "bodies_truncated" BOOLEAN NOT NULL DEFAULT false,
    "transcript_id" UUID,
    "otel_trace_id" TEXT,
    "otel_span_id" TEXT,
    "team_id" UUID,
    "org_id" UUID,
    "started_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_http_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_http_calls_run_id_started_at_idx" ON "workflow_http_calls"("run_id", "started_at");

-- CreateIndex
CREATE INDEX "workflow_http_calls_created_at_idx" ON "workflow_http_calls"("created_at");

-- CreateIndex
CREATE INDEX "workflow_http_calls_workflow_id_temporal_run_id_idx" ON "workflow_http_calls"("workflow_id", "temporal_run_id");

-- CreateIndex
CREATE INDEX "workflow_http_calls_team_id_created_at_idx" ON "workflow_http_calls"("team_id", "created_at");

-- AddForeignKey
ALTER TABLE "workflow_http_calls" ADD CONSTRAINT "workflow_http_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
