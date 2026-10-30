CREATE TABLE "run_evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "spec_node_id" TEXT,
    "step_attempt" INTEGER,
    "caption" TEXT,
    "page_url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "run_evidence_artifact_id_key" ON "run_evidence"("artifact_id");
CREATE INDEX "run_evidence_run_id_created_at_idx" ON "run_evidence"("run_id", "created_at");

ALTER TABLE "run_evidence" ADD CONSTRAINT "run_evidence_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "run_evidence" ADD CONSTRAINT "run_evidence_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "workflow_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
