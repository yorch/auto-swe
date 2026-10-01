/**
 * The scanner-pattern categories — the values of the Prisma
 * `ScannerPatternType` enum, as a runtime list. Dependency-free so the bundle
 * schema (and through it the I/O-free SDK), the gateway's admin route and the
 * DB-backed pattern loader can all share one definition.
 */
export const SCANNER_PATTERN_TYPES = [
  'INJECTION',
  'EXFILTRATION',
  'SHELL_COMMAND',
  'CODE_SECURITY',
  'SENSITIVE_FILE',
  'PII',
] as const;

export type ScannerPatternType = (typeof SCANNER_PATTERN_TYPES)[number];
