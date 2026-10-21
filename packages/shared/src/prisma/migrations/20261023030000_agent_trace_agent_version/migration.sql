-- AlterTable
ALTER TABLE "agent_traces" ADD COLUMN     "agent_id" UUID,
ADD COLUMN     "agent_version" INTEGER;

-- AlterTable
ALTER TABLE "agent_trace_daily_usage" ADD COLUMN     "agent_id" UUID;

