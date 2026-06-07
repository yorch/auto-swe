-- Migration: extend ScannerPatternType enum with SENSITIVE_FILE
--
-- SENSITIVE_FILE patterns are checked before each writeFile tool call in the
-- agent workspace and hard-block writes to sensitive paths (.env, PEM/key files,
-- SSH private keys, credential JSON, etc.).
--
-- Moving these rules to the DB lets admins add custom patterns (e.g. team-specific
-- secret stores) without a worker redeploy. Built-in patterns are seeded via
-- syncBuiltins() at gateway startup.

ALTER TYPE "ScannerPatternType" ADD VALUE IF NOT EXISTS 'SENSITIVE_FILE';
