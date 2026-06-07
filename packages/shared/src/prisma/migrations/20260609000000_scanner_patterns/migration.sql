-- Migration: DB-backed scanner patterns
--
-- Creates the scanner_patterns table to hold injection and exfiltration
-- patterns that were previously hardcoded in skillScanner.ts.
-- Built-in pattern data is seeded via yarn db:seed (seed.ts).

CREATE TYPE "ScannerPatternType" AS ENUM ('INJECTION', 'EXFILTRATION');

CREATE TABLE "scanner_patterns" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "label"      TEXT        NOT NULL,
  "pattern"    TEXT        NOT NULL,
  "flags"      TEXT        NOT NULL DEFAULT '',
  "type"       "ScannerPatternType" NOT NULL,
  "is_active"  BOOLEAN     NOT NULL DEFAULT true,
  "is_built_in" BOOLEAN    NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "scanner_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scanner_patterns_label_key" ON "scanner_patterns"("label");
