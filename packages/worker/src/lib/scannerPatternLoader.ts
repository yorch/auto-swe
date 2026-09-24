/**
 * The DB-backed scanner-pattern loader is one implementation in
 * `@auto-swe/shared` — the gateway's skill scanner uses the same one — so the
 * load rules (compile check, TTL, active-only) cannot drift between processes.
 * Re-exported here so the worker's scanners keep their local import.
 */
export { type CachedEntry, makePatternLoader } from '@auto-swe/shared/lib/scannerCache';
