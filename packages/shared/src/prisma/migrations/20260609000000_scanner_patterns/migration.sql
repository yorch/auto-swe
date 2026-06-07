-- Migration: DB-backed scanner patterns
--
-- Creates the scanner_patterns table and seeds all built-in injection and
-- exfiltration patterns that were previously hardcoded in skillScanner.ts.

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

-- Seed built-in injection patterns
INSERT INTO "scanner_patterns" ("label", "pattern", "flags", "type", "is_active", "is_built_in") VALUES
  ('ignore-previous-instructions', 'ignore\s+(all\s+)?previous\s+instructions', 'i', 'INJECTION', true, true),
  ('forget-instructions',          'forget\s+(everything|all\s+instructions)',   'i', 'INJECTION', true, true),
  ('you-are-now',                  'you\s+are\s+now\s+(a|an)\s+\w',              'i', 'INJECTION', true, true),
  ('act-as-override',              'act\s+as\s+(a|an)\s+\w',                     'i', 'INJECTION', true, true),
  ('disregard-guidelines',         'disregard\s+(your\s+)?(guidelines|instructions|rules)', 'i', 'INJECTION', true, true),
  ('new-instructions',             '---\s*new\s+instructions\s*---',              'i', 'INJECTION', true, true),
  ('system-prompt-override',       '\[SYSTEM\]|\bSYSTEM\s*PROMPT\b',             'i', 'INJECTION', true, true);

-- Seed built-in exfiltration patterns
INSERT INTO "scanner_patterns" ("label", "pattern", "flags", "type", "is_active", "is_built_in") VALUES
  ('http-url-in-instruction', 'https?:\/\/[^\s]+',                                       'i', 'EXFILTRATION', true, true),
  ('base64-block',            '(?:^|[\s"''`])[A-Za-z0-9+/]{60,}={0,2}(?:$|[\s"''`])', 'm', 'EXFILTRATION', true, true),
  ('curl-wget',               '\b(curl|wget)\s+',                                         'i', 'EXFILTRATION', true, true),
  ('send-to-external',        '\b(exfiltrat|send\s+to\s+(http|ftp)|transmit\s+(to|via))\b', 'i', 'EXFILTRATION', true, true);
