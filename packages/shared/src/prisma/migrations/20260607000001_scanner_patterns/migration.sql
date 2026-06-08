-- Migration: DB-backed scanner patterns
--
-- Creates the scanner_patterns table with all five pattern types in a single
-- migration. Types cover:
--
--   INJECTION / EXFILTRATION  — prompt-injection and data-exfiltration guards
--                               for custom skill content (skill scanner)
--   SHELL_COMMAND             — soft-block patterns checked before each bash
--                               tool invocation (shell command scanner)
--   CODE_SECURITY             — advisory diff scan patterns forwarded to the
--                               security reviewer agent (code security scanner)
--   SENSITIVE_FILE            — hard-block patterns checked before each
--                               writeFile call (sensitive file scanner)
--
-- Built-in pattern data is synced via syncBuiltins() at gateway startup.

CREATE TYPE "ScannerPatternType" AS ENUM (
  'INJECTION',
  'EXFILTRATION',
  'SHELL_COMMAND',
  'CODE_SECURITY',
  'SENSITIVE_FILE'
);

CREATE TABLE "scanner_patterns" (
  "id"          UUID                NOT NULL DEFAULT gen_random_uuid(),
  "label"       TEXT                NOT NULL,
  "pattern"     TEXT                NOT NULL,
  "flags"       TEXT                NOT NULL DEFAULT '',
  "type"        "ScannerPatternType" NOT NULL,
  "is_active"   BOOLEAN             NOT NULL DEFAULT true,
  "is_built_in" BOOLEAN             NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ         NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ         NOT NULL DEFAULT now(),

  CONSTRAINT "scanner_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scanner_patterns_label_key" ON "scanner_patterns"("label");
