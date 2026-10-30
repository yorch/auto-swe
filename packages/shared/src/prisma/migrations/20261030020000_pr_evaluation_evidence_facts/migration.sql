-- The facts an evaluation row must carry to count as auto-mode evidence: who requested the work,
-- how much changed, and how many trusted approvals stood at the evaluated head. All nullable, so
-- rows written before this migration keep NULL and stop counting. The composite index serves the
-- per-repository evidence count.
ALTER TABLE "pr_evaluations" ADD COLUMN "requester_id" UUID,
ADD COLUMN "changed_lines" INTEGER,
ADD COLUMN "trusted_approvers" INTEGER;

CREATE INDEX "pr_evaluations_connection_id_risk_class_merged_at_idx" ON "pr_evaluations"("connection_id", "risk_class", "merged_at");
