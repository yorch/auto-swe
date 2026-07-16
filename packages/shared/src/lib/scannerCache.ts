/**
 * Shared TTL for the DB-backed security-scanner pattern caches.
 *
 * The gateway (`skillScanner`) and the worker (`scannerPatternLoader`, which
 * backs the shell/code-security/sensitive-file scanners) are separate
 * processes, so there is no cross-process cache invalidation — a pattern edit
 * in the admin UI only takes effect once this TTL expires in each process.
 * Both processes must therefore agree on the window; keep it single-sourced
 * here so the two never drift.
 */
export const SCANNER_PATTERN_CACHE_TTL_MS = 60_000;
