-- The stack detection each connection a run may use had when the run began, as
-- `{ connectionId: DetectedStack | null }`. A scan that lands mid-run therefore cannot move a later
-- step to another image or directory than an earlier one. Null for a run created before this column
-- existed: it reads the live detection, as it always did.

-- AlterTable
ALTER TABLE "workflow_runs" ADD COLUMN     "pinned_detections" JSONB;
