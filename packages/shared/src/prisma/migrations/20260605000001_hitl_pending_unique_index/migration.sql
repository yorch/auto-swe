-- Prevents duplicate PENDING rows for the same (run_id, node_id) pair.
-- A partial index (WHERE status = 'PENDING') allows multiple historical resolved/cancelled
-- rows for the same node without blocking re-execution in retry loops.
-- This is the DB-level guard for Temporal activity idempotency in createHumanStep.
CREATE UNIQUE INDEX workflow_human_steps_pending_unique
  ON workflow_human_steps (run_id, node_id)
  WHERE status = 'PENDING';
