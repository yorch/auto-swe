-- ----------------------------------------------------------------------------
-- Generic action outcome idempotency: every external side-effect performed by
-- `writeOutcome` is recorded once per (run, node, connection, attempt). A
-- Temporal activity retry (or duplicate scheduling) reads this row back instead
-- of re-issuing the external call. The FK cascades when the parent run is
-- deleted.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "workflow_outcome_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "node_id" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_outcome_references_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "workflow_outcome_references_run_id_idx"
    ON "workflow_outcome_references" ("run_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_outcome_references_run_node_conn_attempt_uidx"
    ON "workflow_outcome_references" ("run_id", "node_id", "connection_id", "attempt");

ALTER TABLE "workflow_outcome_references"
    ADD CONSTRAINT IF NOT EXISTS "workflow_outcome_references_run_id_fkey"
        FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
