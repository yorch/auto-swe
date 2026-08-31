ALTER TYPE "EvalSignalSource" ADD VALUE 'HUMAN_AUDIT';

ALTER TABLE "workflow_runs" ADD COLUMN "has_error" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "human_error_baselines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "outcome_type" TEXT,
    "sample_size" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "error_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "human_error_baselines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "human_error_baselines_org_domain_idx" ON "human_error_baselines"("org_id", "domain", "outcome_type");

ALTER TABLE "human_error_baselines" ADD CONSTRAINT "human_error_baselines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "human_error_baselines" ADD CONSTRAINT "human_error_baselines_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "human_error_baselines" ADD CONSTRAINT "human_error_baselines_sample_size_check" CHECK ("sample_size" >= 0);
ALTER TABLE "human_error_baselines" ADD CONSTRAINT "human_error_baselines_error_count_check" CHECK ("error_count" >= 0);
ALTER TABLE "human_error_baselines" ADD CONSTRAINT "human_error_baselines_error_rate_check" CHECK ("error_rate" >= 0 AND "error_rate" <= 1);
