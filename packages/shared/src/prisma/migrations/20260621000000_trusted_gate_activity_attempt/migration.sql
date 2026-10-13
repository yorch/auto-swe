ALTER TABLE "trusted_knowledge_evidence"
  ADD COLUMN "activity_attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "evidence_correlation" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

ALTER TABLE "trusted_knowledge_evidence"
  ADD CONSTRAINT "trusted_knowledge_evidence_activity_attempt_positive"
  CHECK ("activity_attempt" > 0);

DROP INDEX "trusted_knowledge_evidence_execution_key";
CREATE UNIQUE INDEX "trusted_knowledge_evidence_execution_key"
  ON "trusted_knowledge_evidence"(
    "run_id", "recording_id", "step_attempt", "activity_attempt", "producer", "gate_name"
  );
