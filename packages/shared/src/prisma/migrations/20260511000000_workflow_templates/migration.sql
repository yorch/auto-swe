-- CreateEnum
CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "work_requests"
    ADD COLUMN "template_id" UUID,
    ADD COLUMN "template_version" INTEGER;

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "WorkflowTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active_version" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_team_id_name_key" ON "workflow_templates"("team_id", "name");

-- CreateTable
CREATE TABLE "workflow_template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_key" ON "workflow_template_versions"("template_id", "version");

-- AddForeignKey
ALTER TABLE "workflow_template_versions"
    ADD CONSTRAINT "workflow_template_versions_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" TEXT NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "work_request_id" UUID,
    "spec_snapshot" JSONB NOT NULL,
    "context_snapshot" JSONB,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflow_id_key" ON "workflow_runs"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_runs_template_id_idx" ON "workflow_runs"("template_id");

-- CreateIndex
CREATE INDEX "workflow_runs_work_request_id_idx" ON "workflow_runs"("work_request_id");

-- AddForeignKey
ALTER TABLE "workflow_runs"
    ADD CONSTRAINT "workflow_runs_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs"
    ADD CONSTRAINT "workflow_runs_work_request_id_fkey"
    FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkflowStepStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "inputs" JSONB,
    "outputs" JSONB,
    "error" TEXT,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_idx" ON "workflow_steps"("run_id");

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_node_id_idx" ON "workflow_steps"("run_id", "node_id");

-- AddForeignKey
ALTER TABLE "workflow_steps"
    ADD CONSTRAINT "workflow_steps_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "workflow_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID,
    "kind" TEXT NOT NULL,
    "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "size_bytes" INTEGER NOT NULL,
    "backend" TEXT NOT NULL,
    "s3_bucket" TEXT,
    "s3_key" TEXT,
    "inline_blob" BYTEA,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_artifacts_run_id_idx" ON "workflow_artifacts"("run_id");

-- AddForeignKey
ALTER TABLE "workflow_artifacts"
    ADD CONSTRAINT "workflow_artifacts_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
