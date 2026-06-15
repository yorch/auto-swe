-- Consolidated initial schema, generated from schema.prisma via
-- `prisma migrate diff --from-empty --to-schema --script` (pre-deployment
-- consolidation of the original 18-migration chain; schema-equivalence
-- verified against the old chain with a normalized pg_dump diff).
-- Custom DDL Prisma cannot express lives in the next migration.
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'LEAD', 'ENGINEER');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStepStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConfigScope" AS ENUM ('GLOBAL', 'TEAM', 'WORKFLOW_TEMPLATE');

-- CreateEnum
CREATE TYPE "ConfigAuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateEnum
CREATE TYPE "HumanStepKind" AS ENUM ('APPROVAL', 'DECISION', 'INPUT', 'REVIEW');

-- CreateEnum
CREATE TYPE "HumanStepStatus" AS ENUM ('PENDING', 'RESOLVED', 'TIMED_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScannerPatternType" AS ENUM ('INJECTION', 'EXFILTRATION', 'SHELL_COMMAND', 'CODE_SECURITY', 'SENSITIVE_FILE');

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
CREATE TABLE "agent_lessons" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" UUID,
    "repo_id" UUID,
    "rationale" TEXT NOT NULL,
    "lesson_summary" TEXT NOT NULL,
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "failure_type" TEXT,
    "metadata" JSONB,
    "skills_active" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consolidated_at" TIMESTAMPTZ,

    CONSTRAINT "agent_lessons_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "personal_access_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
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
    "consolidation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "gate_commands" JSONB,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "shell_image_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "egress_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slack_notify_channel" TEXT,
    "slack_notify_success" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "slack_id" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ENGINEER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preferences" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ,
    "refresh_token_expires_at" TIMESTAMPTZ,
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_ticket_id" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "request_payload" TEXT NOT NULL,
    "slack_message_ts" TEXT,
    "slack_channel_id" TEXT,
    "is_cross_repo" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "template_version" INTEGER,
    "requested_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_work_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "repo_id" UUID NOT NULL,
    "template_id" UUID,
    "template_version" INTEGER,
    "description" TEXT NOT NULL,
    "external_ticket_prefix" TEXT NOT NULL,
    "budget_tier" TEXT NOT NULL DEFAULT 'STANDARD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "work_request_id" UUID,
    "last_fired_at" TIMESTAMPTZ,
    "next_fire_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_work_requests_pkey" PRIMARY KEY ("id")
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
    "cost_usd_accrued" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_traces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "agent_role" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "tool_name" TEXT,
    "input_json" JSONB,
    "output_json" JSONB,
    "duration_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_traces_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "workflow_human_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "signal_name" TEXT NOT NULL,
    "kind" "HumanStepKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "context" JSONB,
    "options" JSONB,
    "fields" JSONB,
    "status" "HumanStepStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "payload" JSONB,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_human_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "origin" TEXT,
    "status" "WorkflowTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active_version" INTEGER,
    "experiment_version" INTEGER,
    "experiment_split" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_templates_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "model_role_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "role" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "workflow_template_id" UUID,
    "model_spec" TEXT NOT NULL,
    "system_prompt" TEXT,
    "origin" TEXT,
    "credential_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_role_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "api_base" TEXT,
    "api_key_ciphertext" BYTEA NOT NULL,
    "api_key_nonce" BYTEA NOT NULL,
    "api_key_auth_tag" BYTEA NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "last_four" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embedding_configs" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "model_spec" TEXT NOT NULL,
    "credential_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "token_ciphertext" BYTEA,
    "token_nonce" BYTEA,
    "token_auth_tag" BYTEA,
    "token_key_version" INTEGER,
    "token_last_four" TEXT,
    "webhook_secret_ciphertext" BYTEA,
    "webhook_secret_nonce" BYTEA,
    "webhook_secret_auth_tag" BYTEA,
    "webhook_secret_key_version" INTEGER,
    "webhook_secret_last_four" TEXT,
    "oauth_client_id" TEXT,
    "oauth_client_secret_ciphertext" BYTEA,
    "oauth_client_secret_nonce" BYTEA,
    "oauth_client_secret_auth_tag" BYTEA,
    "oauth_client_secret_key_version" INTEGER,
    "oauth_client_secret_last_four" TEXT,
    "app_id" TEXT,
    "app_client_id" TEXT,
    "app_client_secret_ciphertext" BYTEA,
    "app_client_secret_nonce" BYTEA,
    "app_client_secret_auth_tag" BYTEA,
    "app_client_secret_key_version" INTEGER,
    "app_client_secret_last_four" TEXT,
    "app_private_key_ciphertext" BYTEA,
    "app_private_key_nonce" BYTEA,
    "app_private_key_auth_tag" BYTEA,
    "app_private_key_key_version" INTEGER,
    "app_private_key_last_four" TEXT,
    "app_installation_id" TEXT,
    "auth_mode" TEXT,
    "base_url" TEXT,
    "api_url" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "client_id" TEXT,
    "client_secret_ciphertext" BYTEA,
    "client_secret_nonce" BYTEA,
    "client_secret_auth_tag" BYTEA,
    "client_secret_key_version" INTEGER,
    "client_secret_last_four" TEXT,
    "signing_secret_ciphertext" BYTEA,
    "signing_secret_nonce" BYTEA,
    "signing_secret_auth_tag" BYTEA,
    "signing_secret_key_version" INTEGER,
    "signing_secret_last_four" TEXT,
    "bot_token_ciphertext" BYTEA,
    "bot_token_nonce" BYTEA,
    "bot_token_auth_tag" BYTEA,
    "bot_token_key_version" INTEGER,
    "bot_token_last_four" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "backend" TEXT NOT NULL DEFAULT 'inline',
    "s3_bucket" TEXT,
    "s3_region" TEXT,
    "s3_endpoint" TEXT,
    "s3_prefix" TEXT,
    "s3_force_path_style" BOOLEAN NOT NULL DEFAULT false,
    "aws_access_key_id" TEXT,
    "aws_secret_access_key_ciphertext" BYTEA,
    "aws_secret_access_key_nonce" BYTEA,
    "aws_secret_access_key_auth_tag" BYTEA,
    "aws_secret_access_key_key_version" INTEGER,
    "aws_secret_access_key_last_four" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_defaults" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "branch_prefix" TEXT NOT NULL DEFAULT 'auto',
    "pr_title_template" TEXT NOT NULL DEFAULT '[auto-swe] {{ticketId}}',
    "pr_body_template" TEXT NOT NULL DEFAULT '',
    "default_team_slug" TEXT NOT NULL DEFAULT 'default',
    "consolidation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "consolidation_cron" TEXT NOT NULL DEFAULT '0 3 * * 0',
    "consolidation_min_cluster_size" INTEGER NOT NULL DEFAULT 3,
    "consolidation_similarity_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.85,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_oauth_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "client_id" TEXT,
    "client_secret_ciphertext" BYTEA,
    "client_secret_nonce" BYTEA,
    "client_secret_auth_tag" BYTEA,
    "client_secret_key_version" INTEGER,
    "client_secret_last_four" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_oauth_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracker_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "provider" TEXT,
    "base_url" TEXT,
    "email" TEXT,
    "api_token_ciphertext" BYTEA,
    "api_token_nonce" BYTEA,
    "api_token_auth_tag" BYTEA,
    "api_token_key_version" INTEGER,
    "api_token_last_four" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracker_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" "ConfigAuditAction" NOT NULL,
    "actor_id" UUID,
    "before_json" JSONB,
    "after_json" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "prompt_text" TEXT NOT NULL,
    "origin" TEXT,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_patterns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "label" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "flags" TEXT NOT NULL DEFAULT '',
    "type" "ScannerPatternType" NOT NULL,
    "origin" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_built_in" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skill_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_role" TEXT NOT NULL,
    "skill_id" UUID NOT NULL,
    "origin" TEXT,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "workflow_template_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_skill_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tool_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_role" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "team_id" UUID,
    "workflow_template_id" UUID,
    "enabled_tools" TEXT[],
    "origin" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_tool_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_shell_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_version_id" UUID NOT NULL,
    "team_id" UUID,
    "node_id" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'none',
    "egress_allowlist_snapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_shell_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "active_workflows_temporal_workflow_id_key" ON "active_workflows"("temporal_workflow_id");

-- CreateIndex
CREATE INDEX "active_workflows_work_request_id_idx" ON "active_workflows"("work_request_id");

-- CreateIndex
CREATE INDEX "active_workflows_repo_id_assigned_branch_idx" ON "active_workflows"("repo_id", "assigned_branch");

-- CreateIndex
CREATE INDEX "agent_lessons_repo_id_consolidated_at_idx" ON "agent_lessons"("repo_id", "consolidated_at");

-- CreateIndex
CREATE UNIQUE INDEX "context_snapshots_work_request_id_key" ON "context_snapshots"("work_request_id");

-- CreateIndex
CREATE INDEX "pull_requests_workflow_id_idx" ON "pull_requests"("workflow_id");

-- CreateIndex
CREATE INDEX "pull_requests_repo_id_idx" ON "pull_requests"("repo_id");

-- CreateIndex
CREATE UNIQUE INDEX "personal_access_tokens_token_hash_key" ON "personal_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "personal_access_tokens_user_id_idx" ON "personal_access_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_organization_name_repo_name_key" ON "repositories"("organization_name", "repo_name");

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
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_slack_id_key" ON "users"("slack_id");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "scheduled_work_requests_repo_id_idx" ON "scheduled_work_requests"("repo_id");

-- CreateIndex
CREATE INDEX "workflow_artifacts_run_id_idx" ON "workflow_artifacts"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_runs_workflow_id_key" ON "workflow_runs"("workflow_id");

-- CreateIndex
CREATE INDEX "workflow_runs_template_id_idx" ON "workflow_runs"("template_id");

-- CreateIndex
CREATE INDEX "workflow_runs_work_request_id_idx" ON "workflow_runs"("work_request_id");

-- CreateIndex
CREATE INDEX "agent_traces_run_id_node_id_idx" ON "agent_traces"("run_id", "node_id");

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_idx" ON "workflow_steps"("run_id");

-- CreateIndex
CREATE INDEX "workflow_steps_run_id_node_id_idx" ON "workflow_steps"("run_id", "node_id");

-- CreateIndex
CREATE INDEX "workflow_human_steps_run_id_idx" ON "workflow_human_steps"("run_id");

-- CreateIndex
CREATE INDEX "workflow_human_steps_status_idx" ON "workflow_human_steps"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_templates_team_id_name_key" ON "workflow_templates"("team_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_template_versions_template_id_version_key" ON "workflow_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "model_role_configs_scope_team_id_idx" ON "model_role_configs"("scope", "team_id");

-- CreateIndex
CREATE INDEX "model_role_configs_scope_workflow_template_id_idx" ON "model_role_configs"("scope", "workflow_template_id");

-- CreateIndex
CREATE INDEX "provider_credentials_provider_scope_team_id_idx" ON "provider_credentials"("provider", "scope", "team_id");

-- CreateIndex
CREATE INDEX "config_audit_log_entity_type_entity_id_idx" ON "config_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "config_audit_log_actor_id_idx" ON "config_audit_log"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_patterns_label_key" ON "scanner_patterns"("label");

-- CreateIndex
CREATE INDEX "agent_skill_assignments_agent_role_scope_team_id_idx" ON "agent_skill_assignments"("agent_role", "scope", "team_id");

-- CreateIndex
CREATE INDEX "agent_skill_assignments_agent_role_scope_workflow_template__idx" ON "agent_skill_assignments"("agent_role", "scope", "workflow_template_id");

-- CreateIndex
CREATE INDEX "agent_tool_configs_agent_role_scope_team_id_idx" ON "agent_tool_configs"("agent_role", "scope", "team_id");

-- CreateIndex
CREATE INDEX "agent_tool_configs_agent_role_scope_workflow_template_id_idx" ON "agent_tool_configs"("agent_role", "scope", "workflow_template_id");

-- CreateIndex
CREATE INDEX "workflow_shell_audit_template_version_id_idx" ON "workflow_shell_audit"("template_version_id");

-- CreateIndex
CREATE INDEX "workflow_shell_audit_team_id_idx" ON "workflow_shell_audit"("team_id");

-- AddForeignKey
ALTER TABLE "active_workflows" ADD CONSTRAINT "active_workflows_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_workflows" ADD CONSTRAINT "active_workflows_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_lessons" ADD CONSTRAINT "agent_lessons_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "active_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_lessons" ADD CONSTRAINT "agent_lessons_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "active_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_requests" ADD CONSTRAINT "work_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_work_requests" ADD CONSTRAINT "scheduled_work_requests_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_artifacts" ADD CONSTRAINT "workflow_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "work_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_human_steps" ADD CONSTRAINT "workflow_human_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_human_steps" ADD CONSTRAINT "workflow_human_steps_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_template_versions" ADD CONSTRAINT "workflow_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_role_configs" ADD CONSTRAINT "model_role_configs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding_configs" ADD CONSTRAINT "embedding_configs_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "provider_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skill_assignments" ADD CONSTRAINT "agent_skill_assignments_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_configs" ADD CONSTRAINT "agent_tool_configs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_configs" ADD CONSTRAINT "agent_tool_configs_workflow_template_id_fkey" FOREIGN KEY ("workflow_template_id") REFERENCES "workflow_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_shell_audit" ADD CONSTRAINT "workflow_shell_audit_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "workflow_template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_shell_audit" ADD CONSTRAINT "workflow_shell_audit_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

