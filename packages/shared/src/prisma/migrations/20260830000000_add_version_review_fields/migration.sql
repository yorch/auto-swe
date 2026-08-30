-- Add human-review tracking to AI-generated template versions.
ALTER TABLE "workflow_template_versions" ADD COLUMN "generated_by" TEXT;
ALTER TABLE "workflow_template_versions" ADD COLUMN "reviewed_at" TIMESTAMPTZ;
ALTER TABLE "workflow_template_versions" ADD COLUMN "reviewed_by" UUID;

CREATE INDEX "workflow_template_versions_reviewed_by_idx" ON "workflow_template_versions"("reviewed_by");
