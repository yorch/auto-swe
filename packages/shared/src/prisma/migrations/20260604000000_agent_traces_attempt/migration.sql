-- AlterTable: add attempt column to agent_traces
-- DEFAULT 1 ensures existing rows get the correct initial value without a full-table rewrite.
ALTER TABLE "agent_traces" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
