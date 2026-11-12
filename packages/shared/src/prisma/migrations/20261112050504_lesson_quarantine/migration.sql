CREATE TYPE "LessonQuarantineSource" AS ENUM ('MANUAL', 'FLAG_THRESHOLD');

ALTER TABLE "memory_items"
  ADD COLUMN "quarantined_at" TIMESTAMPTZ,
  ADD COLUMN "quarantined_by_id" UUID,
  ADD COLUMN "quarantine_reason" VARCHAR(500),
  ADD COLUMN "quarantine_source" "LessonQuarantineSource";

ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_quarantined_by_id_fkey"
  FOREIGN KEY ("quarantined_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
