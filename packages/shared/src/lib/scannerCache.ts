/**
 * Shared TTL for the DB-backed security-scanner pattern caches.
 *
 * The gateway (`skillScanner`) and the worker (`scannerPatternLoader`, which
 * backs the shell/code-security/sensitive-file scanners) are separate
 * processes, so there is no cross-process cache invalidation — a pattern edit
 * in the admin UI only takes effect once this TTL expires in each process.
 * Both processes must therefore agree on the window; it is single-sourced in
 * `scannerPatternLoader.ts` (the one loader both use) and re-exported here,
 * together with the loader itself, so neither process needs a new package
 * export to reach them.
 */
export {
  type CachedEntry,
  makePatternLoader,
  SCANNER_PATTERN_CACHE_TTL_MS,
  SCANNER_PATTERN_TYPES,
  type ScannerPatternType,
} from './scannerPatternLoader.js';

// The scanner trace tags are single-sourced for the same reason as the TTL
// above — writer (worker) and readers (gateway, trajectory scorer) are
// different processes — and ship through this subpath so no new package
// export is needed.
export {
  isSecurityBlockTraceError,
  SECURITY_BLOCK_TRACE_ERRORS,
  SECURITY_TRACE_ERRORS,
  type SecurityTraceError,
} from './securityTraceTags.js';
