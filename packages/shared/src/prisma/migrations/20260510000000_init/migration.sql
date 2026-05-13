-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'LEAD', 'ENGINEER');

-- CreateEnum
CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "slack_id" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ENGINEER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "shell_image_allowlist" TEXT[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ENGINEER',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_name" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "language" TEXT,
    "description" TEXT,
    "github_url" TEXT,
    "github_api_url" TEXT,
    "mcp_server_ref" TEXT,
    "team_id" UUID NOT NULL,
    "executor_image" TEXT DEFAULT 'node:24-alpine',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "gate_commands" JSONB,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_ticket_id" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "request_payload" TEXT NOT NULL,
    "slack_message_ts" TEXT,
    "is_cross_repo" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "template_version" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "work_request_id" UUID NOT NULL,
    "raw_jira_epic" JSONB,
    "raw_confluence" JSONB,
    "success_criteria" TEXT[],
    "captured_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_workflows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "temporal_workflow_id" TEXT NOT NULL,
    "parent_workflow_id" TEXT,
    "work_request_id" UUID,
    "repo_id" UUID,
    "current_status" TEXT NOT NULL,
    "assigned_branch" TEXT,
    "budget_tier" TEXT NOT NULL DEFAULT 'STANDARD',
    "tokens_input_used" INTEGER NOT NULL DEFAULT 0,
    "tokens_output_used" INTEGER NOT NULL DEFAULT 0,
    "cost_usd_accrued" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID,
    "repo_id" UUID,
    "pr_number" INTEGER,
    "head_sha" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ci_status" TEXT NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_lessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID,
    "repo_id" UUID,
    "rationale" TEXT NOT NULL,
    "lesson_summary" TEXT NOT NULL,
    "embedding" vector(1536),
    "failure_type" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "WorkflowTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active_version" INTEGER,
    "experiment_version" INTEGER,
    "experiment_split" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workflow_templates_experiment_split_range"
        CHECK ("experiment_split" IS NULL OR ("experiment_split" >= 0 AND "experiment_split" <= 100))
);

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
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_slack_id_key" ON "users"("slack_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");

-- CreateIndex
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "teams_slug_key" ON "teams"("slug");

-- CreateIndex
CREATE INDEX "team_memberships_user_id_idx" ON "team_memberships"("user_id");

-- CreateIndex
CREATE INDEX "team_memberships_team_id_idx" ON "team_memberships"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_memberships_user_id_team_id_key" ON "team_memberships"("user_id", "team_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_organization_name_repo_name_key" ON "repositories"("organization_name", "repo_name");

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshots_work_request_id_key" ON "context_snapshots"("work_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "active_workflows_temporal_workflow_id_key" ON "active_workflows"("temporal_workflow_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_team_id_name_key" ON "workflow_templates"("team_id", "name");

-- CreateIndex
-- Postgres treats NULLs as distinct under standard UNIQUE constraints, so the
-- (team_id, name) index above does NOT prevent duplicate global templates with
-- the same name. Enforce it explicitly via a partial unique index.
CREATE UNIQUE INDEX "workflow_templates_global_name_key" ON "workflow_templates"("name") WHERE "team_id" IS NULL;

-- CreateIndex
-- Resolve-default queries (gateway resolveDefaultTemplate / worker
-- resolveTemplateForRepo) pick the single active default per team and fall
-- back to the global default. Both must be unique to keep resolution
-- deterministic.
CREATE UNIQUE INDEX "workflow_templates_team_default_unique" ON "workflow_templates"("team_id") WHERE "is_default" = TRUE AND "team_id" IS NOT NULL;
CREATE UNIQUE INDEX "workflow_templates_global_default_unique" ON "workflow_templates"((1)) WHERE "is_default" = TRUE AND "team_id" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_key" ON "workflow_template_versions"("template_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflow_id_key" ON "workflow_runs"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_runs_template_id_idx" ON "workflow_runs"("template_id");

-- CreateIndex
CREATE INDEX "workflow_runs_work_request_id_idx" ON "workflow_runs"("work_request_id");

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_idx" ON "workflow_steps"("run_id");

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_node_id_idx" ON "workflow_steps"("run_id", "node_id");

-- CreateIndex
CREATE INDEX "workflow_artifacts_run_id_idx" ON "workflow_artifacts"("run_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_workflows" ADD CONSTRAINT "active_workflows_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_workflows" ADD CONSTRAINT "active_workflows_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "active_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_lessons" ADD CONSTRAINT "agent_lessons_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "active_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_lessons" ADD CONSTRAINT "agent_lessons_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 6: shell-step audit trail. One row per shell node authored in a
-- template version, captured at save time so a team admin can answer "who
-- added this command in version N?" without scanning JSON specs.
-- CreateTable
CREATE TABLE "workflow_shell_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_version_id" UUID NOT NULL,
    "team_id" UUID,
    "node_id" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'none',
    "author_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_shell_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_shell_audit_template_version_id_idx" ON "workflow_shell_audit"("template_version_id");

-- CreateIndex
CREATE INDEX "workflow_shell_audit_team_id_idx" ON "workflow_shell_audit"("team_id");

-- AddForeignKey
ALTER TABLE "workflow_shell_audit" ADD CONSTRAINT "workflow_shell_audit_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_shell_audit" ADD CONSTRAINT "workflow_shell_audit_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

