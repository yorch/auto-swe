-- Migration: extend ScannerPatternType enum with SHELL_COMMAND and CODE_SECURITY
--
-- SHELL_COMMAND patterns are checked before each bash tool invocation in the
-- agent workspace and soft-block dangerous commands (rm -rf /, iptables -F, etc.).
--
-- CODE_SECURITY patterns scan added lines in the final diff and pass advisory
-- findings to the security reviewer agent in the review network.
--
-- Built-in patterns for both types are seeded via yarn db:seed (seed.ts).

ALTER TYPE "ScannerPatternType" ADD VALUE IF NOT EXISTS 'SHELL_COMMAND';
ALTER TYPE "ScannerPatternType" ADD VALUE IF NOT EXISTS 'CODE_SECURITY';
