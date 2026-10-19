-- Stack detected from a repository's root files by the scheduled dependency
-- scan, persisted as a suggestion (see `detectStack` in shared/lib). JSONB like
-- the neighbouring `gate_commands`; both nullable — no scan, no value.

-- AlterTable
ALTER TABLE "connections" ADD COLUMN "detected_stack" JSONB,
ADD COLUMN "detected_stack_at" TIMESTAMPTZ;
