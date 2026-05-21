/// Tiny TTL cache shared by `resolveModelConfig` and `resolveProviderCredential`.
/// Cardinality is low (~6 roles × N teams × M templates), so a Map keyed by a
/// composite string is enough — no LRU eviction needed.
///
/// TTL is intentionally short so config edits in the dashboard take effect on
/// the next activity call without a worker restart.

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const value = await fetcher();
  store.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

/// Drops a single key from the cache. Used to keep negative results
/// (env-fallback model specs, missing credentials) from sticking around for
/// the full TTL — operators expect DB inserts to take effect immediately.
export function invalidate(key: string): void {
  store.delete(key);
}

export function configCacheTtlMs(): number {
  const envValue = process.env.CONFIG_CACHE_TTL_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_MS;
}

/// Test-only escape hatch. Drops every entry so the next call goes back to the DB.
export function _resetConfigCacheForTests(): void {
  store.clear();
}
