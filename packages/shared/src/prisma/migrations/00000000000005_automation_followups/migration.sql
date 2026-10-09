-- A decision taken again (a redelivered failed start, or a manager's retry) keeps its row,
-- moved aside under `<dedupe key>~<its id>` and marked here; the new decision holds the key.
ALTER TABLE "automation_fires" ADD COLUMN "retried_at" TIMESTAMPTZ;
