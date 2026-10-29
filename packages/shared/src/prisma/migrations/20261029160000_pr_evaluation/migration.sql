-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "pr_evaluation_mode" TEXT;

-- CreateTable
CREATE TABLE "pr_evaluations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "head_sha" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "risk_class" TEXT NOT NULL,
    "required_approvers" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "brief" JSONB NOT NULL,
    "readiness" JSONB,
    "status_state" TEXT NOT NULL,
    "auto_merge_enabled" BOOLEAN NOT NULL DEFAULT false,
    "triggered_by" TEXT NOT NULL,
    "merged_at" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "bad_merge" BOOLEAN NOT NULL DEFAULT false,
    "bad_merge_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pr_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pr_evaluations_connection_id_pr_number_idx" ON "pr_evaluations"("connection_id", "pr_number");

-- CreateIndex
CREATE INDEX "pr_evaluations_risk_class_merged_at_idx" ON "pr_evaluations"("risk_class", "merged_at");

-- AddForeignKey
ALTER TABLE "pr_evaluations" ADD CONSTRAINT "pr_evaluations_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: values Prisma cannot constrain. A NULL pr_evaluation_mode means "inherit the
-- registry default" and passes the CHECK; anything else must be a known mode, so an unknown
-- value is refused at the database instead of being read as a permissive one.
ALTER TABLE "connections" ADD CONSTRAINT "connections_pr_evaluation_mode_check"
    CHECK ("pr_evaluation_mode" IN ('off', 'advisory', 'auto'));

ALTER TABLE "pr_evaluations" ADD CONSTRAINT "pr_evaluations_risk_class_check"
    CHECK ("risk_class" IN ('LOW', 'STANDARD', 'HIGH'));

ALTER TABLE "pr_evaluations" ADD CONSTRAINT "pr_evaluations_mode_check"
    CHECK ("mode" IN ('off', 'advisory', 'auto'));
