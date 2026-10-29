-- The stack detection each connection a run may use had when the run began, as
-- `{ connectionId: DetectedStack | null }`. A scan that lands mid-run therefore cannot move a later
-- step to another image or directory than an earlier one. Null for a run created before this column
-- existed: it reads the live detection, as it always did.
--
-- `pinned_detections_for` is the Temporal run id of the execution that took the pin. A later
-- execution that reuses the workflow id differs from it and takes a fresh snapshot; a retry of the
-- same execution finds it equal and keeps the pin. It is a column of its own because
-- `temporal_run_id` is written on create only, so that it names the FIRST execution for the
-- launcher-credential check, and a rule built on it would re-pin on every attempt of a later one.

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "pinned_detections" JSONB,
ADD COLUMN     "pinned_detections_for" TEXT;
