-- CreateTable
CREATE TABLE "agent_trace_daily_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "day" DATE NOT NULL,
    "team_id" UUID,
    "org_id" UUID,
    "run_id" UUID,
    "agent_key" TEXT NOT NULL,
    "model" TEXT,
    "node_id" TEXT NOT NULL,
    "launcher_id" UUID,
    "calls" INTEGER NOT NULL,
    "errors" INTEGER NOT NULL,
    "input_tokens" BIGINT NOT NULL,
    "output_tokens" BIGINT NOT NULL,
    "cost_usd" DECIMAL(18,10) NOT NULL,
    "ok_duration_ms" BIGINT NOT NULL,
    "ok_duration_count" INTEGER NOT NULL,

    CONSTRAINT "agent_trace_daily_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_trace_daily_usage_day_team_id_idx" ON "agent_trace_daily_usage"("day", "team_id");

-- CreateIndex
CREATE INDEX "agent_trace_daily_usage_day_org_id_idx" ON "agent_trace_daily_usage"("day", "org_id");

-- CreateIndex
CREATE INDEX "agent_trace_daily_usage_launcher_id_day_idx" ON "agent_trace_daily_usage"("launcher_id", "day");

-- CreateIndex
CREATE INDEX "agent_trace_daily_usage_run_id_idx" ON "agent_trace_daily_usage"("run_id");

