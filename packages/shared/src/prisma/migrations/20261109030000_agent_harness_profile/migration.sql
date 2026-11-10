-- AlterTable
ALTER TABLE "agents" ADD COLUMN "harness_profile" TEXT;

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN "harness_profile_versions" JSONB;
