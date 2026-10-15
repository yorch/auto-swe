-- The ledger records an external effect *before* it is performed, so a retry can tell "never
-- attempted" from "attempted, outcome unknown". Without that, a send whose response was lost was
-- repeated by the retry — documented as the ledger's limitation (`docs/autonomy-policies.md`).
--
-- The enum, the column and the index changes are what `prisma migrate diff
-- --from-config-datasource --to-schema` proposed against a database carrying every migration before
-- this one. The deduplication between them is hand-written: data, not DDL, which the schema cannot
-- express.
CREATE TYPE "OutcomeState" AS ENUM ('PENDING', 'DONE');

ALTER TABLE "workflow_outcome_references" ADD COLUMN     "state" "OutcomeState" NOT NULL DEFAULT 'DONE',
ALTER COLUMN "result" DROP NOT NULL;

DROP INDEX "workflow_outcome_references_run_id_node_id_connection_id_at_key";

-- The key narrows to the effect itself and drops `attempt`: a retry *is* a new attempt, so the wider
-- key let one effect own several rows and left the concurrent case unprotected. Existing rows
-- collapse to the earliest attempt of each effect — the row the old lookup returned, since it
-- ordered by `attempt` ascending — and the later duplicates are dropped. This must run before the
-- unique index, which the duplicates would otherwise refuse.
DELETE FROM "workflow_outcome_references" AS later USING "workflow_outcome_references" AS earlier
WHERE later."run_id" = earlier."run_id"
  AND later."node_id" = earlier."node_id"
  AND later."connection_id" = earlier."connection_id"
  AND (
    earlier."attempt" < later."attempt"
    OR (earlier."attempt" = later."attempt" AND earlier."id" < later."id")
  );

CREATE UNIQUE INDEX "workflow_outcome_references_run_id_node_id_connection_id_key" ON "workflow_outcome_references"("run_id", "node_id", "connection_id");
