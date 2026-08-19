/// The config TTL cache moved to `@auto-swe/shared/config/cache` so the gateway
/// resolves settings through the same cache the worker does — one answer to
/// "how long until my change takes effect" instead of three. Re-exported here
/// because the worker's own resolvers import it by this path.
export {
  _cacheSizeForTests,
  _resetConfigCacheForTests,
  configCacheTtlMs,
  invalidate,
  withCache,
} from '@auto-swe/shared/config/cache';
