-- AlterTable
ALTER TABLE "active_workflows" ADD COLUMN     "tokens_input_counted_used" BIGINT NOT NULL DEFAULT 0;

-- Data fix, not generated. Before this column every input token counted toward
-- the cap, so each existing row's raw total is its counted total; runs in flight
-- keep the figure they had accrued. The table also keeps finished runs, so only
-- rows with spend are touched.
UPDATE "active_workflows" SET "tokens_input_counted_used" = "tokens_input_used" WHERE "tokens_input_used" <> 0;
