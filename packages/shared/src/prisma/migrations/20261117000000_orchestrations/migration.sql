-- CreateEnum
CREATE TYPE "OrchestrationStatus" AS ENUM ('ACTIVE', 'WAITING', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrchestrationChildRole" AS ENUM ('READER', 'WRITER');

-- CreateEnum
CREATE TYPE "OrchestrationMessageRole" AS ENUM ('USER', 'ORCHESTRATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OrchestrationMessageKind" AS ENUM ('TEXT', 'ATTACH_REQUEST', 'APPROVAL_REQUEST', 'CHILD_RESULT', 'NOTICE');

-- CreateEnum
CREATE TYPE "OrchestrationApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED');

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "orchestration_id" UUID;

-- CreateTable
CREATE TABLE "orchestrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "team_id" UUID NOT NULL,
    "org_id" UUID,
    "launched_by_id" UUID,
    "service_id" UUID,
    "repo_id" UUID,
    "repo_attached_at" TIMESTAMPTZ,
    "status" "OrchestrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "connection_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "budget_tier" TEXT NOT NULL DEFAULT 'STANDARD',
    "delivery_default" TEXT NOT NULL DEFAULT 'none',
    "work_request_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "orchestrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_children" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orchestration_id" UUID NOT NULL,
    "work_request_id" UUID NOT NULL,
    "run_id" UUID,
    "agent_key" TEXT NOT NULL,
    "role" "OrchestrationChildRole" NOT NULL,
    "label" TEXT NOT NULL,
    "path_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "result_json" JSONB,
    "cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "orchestration_children_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orchestration_id" UUID NOT NULL,
    "role" "OrchestrationMessageRole" NOT NULL,
    "child_id" UUID,
    "author_id" UUID,
    "body" TEXT NOT NULL DEFAULT '',
    "kind" "OrchestrationMessageKind" NOT NULL DEFAULT 'TEXT',
    "payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orchestration_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orchestration_id" UUID NOT NULL,
    "child_id" UUID,
    "connection_id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments_digest" TEXT NOT NULL,
    "status" "OrchestrationApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ,
    "outcome" JSONB,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orchestration_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_steering_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "author_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,

    CONSTRAINT "run_steering_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orchestrations_work_request_id_key" ON "orchestrations"("work_request_id");

-- CreateIndex
CREATE INDEX "orchestrations_team_id_updated_at_idx" ON "orchestrations"("team_id", "updated_at");

-- CreateIndex
CREATE INDEX "orchestrations_launched_by_id_updated_at_idx" ON "orchestrations"("launched_by_id", "updated_at");

-- CreateIndex
CREATE INDEX "orchestrations_status_updated_at_idx" ON "orchestrations"("status", "updated_at");

-- CreateIndex
CREATE INDEX "orchestrations_repo_id_idx" ON "orchestrations"("repo_id");

-- CreateIndex
CREATE INDEX "orchestration_children_orchestration_id_created_at_idx" ON "orchestration_children"("orchestration_id", "created_at");

-- CreateIndex
CREATE INDEX "orchestration_children_run_id_idx" ON "orchestration_children"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "orchestration_children_orchestration_id_work_request_id_key" ON "orchestration_children"("orchestration_id", "work_request_id");

-- CreateIndex
CREATE INDEX "orchestration_messages_orchestration_id_created_at_idx" ON "orchestration_messages"("orchestration_id", "created_at");

-- CreateIndex
CREATE INDEX "orchestration_messages_child_id_idx" ON "orchestration_messages"("child_id");

-- CreateIndex
CREATE INDEX "orchestration_approvals_orchestration_id_created_at_idx" ON "orchestration_approvals"("orchestration_id", "created_at");

-- CreateIndex
CREATE INDEX "orchestration_approvals_status_expires_at_idx" ON "orchestration_approvals"("status", "expires_at");

-- CreateIndex
CREATE INDEX "run_steering_messages_run_id_created_at_idx" ON "run_steering_messages"("run_id", "created_at");

-- CreateIndex
CREATE INDEX "workflow_runs_orchestration_id_idx" ON "workflow_runs"("orchestration_id");

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_launched_by_id_fkey" FOREIGN KEY ("launched_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "run_inputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_work_request_id_fkey" FOREIGN KEY ("work_request_id") REFERENCES "run_inputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_messages" ADD CONSTRAINT "orchestration_messages_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_messages" ADD CONSTRAINT "orchestration_messages_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "orchestration_children"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_messages" ADD CONSTRAINT "orchestration_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_approvals" ADD CONSTRAINT "orchestration_approvals_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_approvals" ADD CONSTRAINT "orchestration_approvals_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "orchestration_children"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_approvals" ADD CONSTRAINT "orchestration_approvals_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_steering_messages" ADD CONSTRAINT "run_steering_messages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_steering_messages" ADD CONSTRAINT "run_steering_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written: Prisma cannot express NOT NULL on a list column, and an unset list would turn
-- every "is this agent allowed" / "does this scope overlap" read into a null check.
ALTER TABLE "orchestrations" ALTER COLUMN "allowlist" SET NOT NULL;
ALTER TABLE "orchestrations" ALTER COLUMN "connection_ids" SET NOT NULL;
ALTER TABLE "orchestration_children" ALTER COLUMN "path_scopes" SET NOT NULL;

-- Hand-written: string columns that hold a closed vocabulary Prisma has no enum for.
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_budget_tier_check" CHECK ("budget_tier" IN ('STANDARD', 'LARGE', 'EPIC'));
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_delivery_default_check" CHECK ("delivery_default" IN ('none', 'branch', 'draft_pr'));
ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_status_check" CHECK ("status" IN ('STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'));

-- Hand-written: a reader carries no path scopes and a writer carries at least one, so a child row
-- can never contradict the role rules the gateway enforced when it was created.
ALTER TABLE "orchestration_children" ADD CONSTRAINT "orchestration_children_role_scopes_check" CHECK (("role" = 'READER' AND cardinality("path_scopes") = 0) OR ("role" = 'WRITER' AND cardinality("path_scopes") BETWEEN 1 AND 20));

-- Hand-written: an attached repository always carries the time it was attached.
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_repo_attached_check" CHECK ("repo_id" IS NULL OR "repo_attached_at" IS NOT NULL);

-- Hand-written: someone launched it, a person or a service principal, never both.
ALTER TABLE "orchestrations" ADD CONSTRAINT "orchestrations_launcher_check" CHECK ("launched_by_id" IS NULL OR "service_id" IS NULL);

-- Hand-written: a pending approval has no decision time.
ALTER TABLE "orchestration_approvals" ADD CONSTRAINT "orchestration_approvals_decided_check" CHECK (("status" = 'PENDING' AND "decided_at" IS NULL) OR ("status" <> 'PENDING'));
