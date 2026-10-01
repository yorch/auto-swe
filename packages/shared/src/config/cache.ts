/// Process-local TTL cache shared by the model + credential resolvers and
/// by `currentRequestContext()`. Bounded LRU + lazy eviction:
///
///   - The cache stores up to MAX_ENTRIES (1000 by default). When the cap is
///     reached we evict the least-recently-used entry on the next insert.
///   - On every read we also opportunistically purge any expired entries we
///     encounter so a `currentWorkflowId`-keyed cache (high cardinality —
///     one entry per workflow execution) doesn't grow unbounded in a long-
///     lived worker process.
///   - TTL is short on purpose so config edits in the dashboard take effect
///     on the next activity call without a worker restart. Override with
///     `CONFIG_CACHE_TTL_MS`.
///
/// We deliberately do NOT cache plaintext API keys longer than necessary —
/// any cache entry holding a `ResolvedModelConfig` / `ResolvedEmbeddingConfig`
/// shape contains a decrypted apiKey for the duration of its TTL.

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Insertion-order iteration is part of Map's contract, so the oldest key in
// `store.keys()` is the LRU candidate. We re-insert on every successful read
// to keep recency information up to date.
const store = new Map<string, CacheEntry<unknown>>();

function maxEntries(): number {
  const env = process.env.CONFIG_CACHE_MAX_ENTRIES;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return DEFAULT_MAX_ENTRIES;
}

/// Evicts entries whose TTL has elapsed. Bounded work — O(n) in the size of
/// the cache — but in practice triggered only when the cap is hit, so amortized
/// cost is O(1) per insert.
function purgeExpired(now: number): void {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) {
      store.delete(k);
    }
  }
}

function enforceCap(): void {
  const cap = maxEntries();
  while (store.size > cap) {
    // Map iteration order = insertion order. After `purgeExpired` ran, the
    // oldest remaining key is the LRU candidate.
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    store.delete(oldest);
  }
}

/// A fetch in progress for one key. `stale` is set when the key is
/// invalidated while the fetch is still running: its result was read before
/// the write that triggered the invalidation, so it must not be stored.
interface InFlight {
  promise: Promise<unknown>;
  stale: boolean;
}

const inflight = new Map<string, InFlight>();

function markStale(predicate: (key: string) => boolean): void {
  for (const [key, entry] of inflight) {
    if (predicate(key)) {
      entry.stale = true;
      // A caller arriving after the invalidation starts a fresh fetch rather
      // than joining one that read the old state.
      inflight.delete(key);
    }
  }
}

export async function withCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  // Optional predicate: when it returns false the freshly-fetched value is
  // returned but NOT stored. Lets callers skip caching negative/empty results
  // (e.g. a context lookup that raced ahead of its DB rows) without the
  // store-then-invalidate churn.
  shouldCache?: (value: T) => boolean
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    // Touch the entry: move to most-recently-inserted position so the LRU
    // eviction at insert time doesn't drop a fresh row.
    store.delete(key);
    store.set(key, hit);
    return hit.value as T;
  }
  // Concurrent misses on one key share one fetch instead of each hitting the
  // DB. The first caller's `shouldCache` decides whether the result is stored.
  const running = inflight.get(key);
  if (running) {
    return running.promise as Promise<T>;
  }
  const entry: InFlight = { promise: Promise.resolve(), stale: false };
  entry.promise = (async () => {
    try {
      const value = await fetcher();
      // An invalidation that landed while this fetch ran means the value may
      // predate the write that caused it; returning it to this caller is fine
      // (it asked before the write), caching it for everyone else is not.
      if (!entry.stale && (!shouldCache || shouldCache(value))) {
        // Lazy sweep + cap enforcement only when we actually insert — avoids
        // O(n) work on every read.
        purgeExpired(now);
        store.set(key, { expiresAt: now + ttlMs, value });
        enforceCap();
      }
      return value;
    } finally {
      if (inflight.get(key) === entry) {
        inflight.delete(key);
      }
    }
  })();
  inflight.set(key, entry);
  return entry.promise as Promise<T>;
}

/// Drops a single key from the cache. Used to keep negative results (missing
/// credentials, cross-scope GLOBAL fallbacks for team lookups) from sticking
/// around for the full TTL — operators expect DB inserts to take effect
/// immediately on the next activity call. A fetch for the key already in
/// flight will not store its result.
export function invalidate(key: string): void {
  store.delete(key);
  markStale((k) => k === key);
}

export function configCacheTtlMs(): number {
  const envValue = process.env.CONFIG_CACHE_TTL_MS;
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_TTL_MS;
}

/// Drops every entry whose key starts with `prefix`. The settings resolver
/// caches one entry per resolution context, so a write at any scope can
/// invalidate many of them — a GLOBAL edit changes what every team resolves.
/// Walking the store is cheap next to leaving an admin's save invisible for a
/// full TTL.
///
/// Fetches already in flight for a matching key are marked stale so they do
/// not store a value read before the write that triggered this call.
export function invalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
  markStale((k) => k.startsWith(prefix));
}

/// Test-only escape hatch. Drops every entry so the next call goes back to the DB.
export function _resetConfigCacheForTests(): void {
  store.clear();
  markStale(() => true);
}

/// Test-only inspector — exposes cache size so a test can assert the
/// LRU + eviction behaviour without poking at module-private state.
export function _cacheSizeForTests(): number {
  return store.size;
}
