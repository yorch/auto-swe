-- AlterTable
ALTER TABLE "event_endpoints" ADD COLUMN "fixed_type" TEXT;

-- A constant event type is 1..256 characters of the same safe set the API accepts, and replaces
-- the type pointer (stored as '') instead of sitting beside it.
DO $$ BEGIN
  ALTER TABLE "event_endpoints" ADD CONSTRAINT "event_endpoints_fixed_type_check"
    CHECK (
      "fixed_type" IS NULL
      OR (
        "type_pointer" = ''
        AND char_length("fixed_type") BETWEEN 1 AND 256
        AND "fixed_type" ~ '^[A-Za-z0-9._:@+=/-]+$'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
