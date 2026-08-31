-- Phase 5 metrics: denormalized run metadata and template time-saved assumptions.
ALTER TABLE "workflow_runs" ADD COLUMN "estimated_human_time_saved" DOUBLE PRECISION;
ALTER TABLE "workflow_runs" ADD COLUMN "outcome_domain" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "outcome_type" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "had_human_step" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workflow_runs" ADD COLUMN "was_autonomous" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "workflow_templates" ADD COLUMN "estimated_human_time_saved_minutes" DOUBLE PRECISION;

CREATE INDEX "workflow_runs_outcome_domain_idx" ON "workflow_runs"("outcome_domain");
CREATE INDEX "workflow_runs_outcome_type_idx" ON "workflow_runs"("outcome_type");
CREATE INDEX "workflow_runs_had_human_step_idx" ON "workflow_runs"("had_human_step");
CREATE INDEX "workflow_runs_was_autonomous_idx" ON "workflow_runs"("was_autonomous");
