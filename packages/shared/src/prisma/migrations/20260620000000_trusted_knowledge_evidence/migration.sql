CREATE TYPE "KnowledgeEvidenceProducer" AS ENUM ('QUALITY_GATE');
CREATE TYPE "KnowledgeEvidenceOutcome" AS ENUM ('PASSED');

CREATE TABLE "trusted_knowledge_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "temporal_run_id" TEXT NOT NULL,
  "recording_id" TEXT NOT NULL,
  "spec_node_id" TEXT NOT NULL,
  "step_attempt" INTEGER NOT NULL,
  "producer" "KnowledgeEvidenceProducer" NOT NULL,
  "gate_name" TEXT NOT NULL,
  "outcome" "KnowledgeEvidenceOutcome" NOT NULL,
  "artifact_id" UUID,
  "summary" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trusted_knowledge_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trusted_knowledge_evidence_attempt_positive" CHECK ("step_attempt" > 0),
  CONSTRAINT "trusted_knowledge_evidence_gate_name_check" CHECK (
    "gate_name" IN ('runLint', 'runTypecheck', 'runTests', 'runBuild', 'runVulnScan', 'runPerfBench')
  ),
  CONSTRAINT "trusted_knowledge_evidence_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "trusted_knowledge_evidence_artifact_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "workflow_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "trusted_knowledge_evidence_execution_key"
  ON "trusted_knowledge_evidence"("run_id", "recording_id", "step_attempt", "producer", "gate_name");
CREATE INDEX "trusted_knowledge_evidence_run_artifact_idx"
  ON "trusted_knowledge_evidence"("run_id", "artifact_id");
