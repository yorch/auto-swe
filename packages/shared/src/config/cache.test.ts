import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _cacheSizeForTests,
  _resetConfigCacheForTests,
  configCacheTtlMs,
  invalidate,
  invalidatePrefix,
  withCache,
} from './cache.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetConfigCacheForTests();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  _resetConfigCacheForTests();
});

describe('withCache', () => {
  it('hits the cache on the second call inside the TTL window', async () => {
    const fetcher = vi.fn().mockResolvedValue('v1');
    await withCache('k', 30_000, fetcher);
    await withCache('k', 30_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache when shouldCache returns false (re-fetches each call)', async () => {
    const fetcher = vi.fn().mockResolvedValue('');
    const shouldCache = (v: string) => v.length > 0;
    const r1 = await withCache('k', 30_000, fetcher, shouldCache);
    const r2 = await withCache('k', 30_000, fetcher, shouldCache);
    expect(r1).toBe('');
    expect(r2).toBe('');
    // Empty result was returned but never stored, so both calls hit the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(_cacheSizeForTests()).toBe(0);
  });

  it('caches when shouldCache returns true', async () => {
    const fetcher = vi.fn().mockResolvedValue('v1');
    const shouldCache = (v: string) => v.length > 0;
    await withCache('k', 30_000, fetcher, shouldCache);
    const r = await withCache('k', 30_000, fetcher, shouldCache);
    expect(r).toBe('v1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(_cacheSizeForTests()).toBe(1);
  });

  it('re-fetches after TTL expires', async () => {
    // Real timers with a tiny TTL — fake timers + async resolver can race on
    // CI runners (we've seen unexplained intermittent failures under
    // Node 24 + fake-timer-driven cache tests).
    const fetcher = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    await withCache('k', 50, fetcher);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const r = await withCache('k', 50, fetcher);
    expect(r).toBe('v2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate() drops a single entry', async () => {
    const fetcher = vi.fn().mockResolvedValue('v');
    await withCache('k', 30_000, fetcher);
    invalidate('k');
    await withCache('k', 30_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('bounded cache (LRU + sweep)', () => {
  it('caps cache size at CONFIG_CACHE_MAX_ENTRIES, evicting LRU on overflow', async () => {
    process.env.CONFIG_CACHE_MAX_ENTRIES = '3';
    _resetConfigCacheForTests();

    // Insert 5 entries; only the 3 most-recently-used should remain.
    for (const k of ['a', 'b', 'c', 'd', 'e']) {
      await withCache(k, 60_000, async () => k);
    }
    expect(_cacheSizeForTests()).toBe(3);
  });

  it('touches the entry on read so the LRU policy keeps actively-used keys', async () => {
    process.env.CONFIG_CACHE_MAX_ENTRIES = '3';
    _resetConfigCacheForTests();
    const make = (k: string) => withCache(k, 60_000, async () => k);
    await make('a');
    await make('b');
    await make('c');
    // Read 'a' so it becomes most-recently-used.
    await make('a');
    // Insert 'd' — should evict 'b' (now the LRU), not 'a'.
    await make('d');

    // 'a' is still in the cache (hit, no re-fetch).
    let aFetchCount = 0;
    await withCache('a', 60_000, async () => {
      aFetchCount += 1;
      return 'a-refetched';
    });
    expect(aFetchCount).toBe(0);
  });

  it('sweeps expired entries on insert (lazy eviction)', async () => {
    // Real timers — see comment in `re-fetches after TTL expires`.
    process.env.CONFIG_CACHE_MAX_ENTRIES = '100';
    _resetConfigCacheForTests();

    // Insert 10 entries with a tiny TTL.
    for (const k of Array.from({ length: 10 }, (_, i) => `k${i}`)) {
      await withCache(k, 50, async () => k);
    }
    expect(_cacheSizeForTests()).toBe(10);

    // Wait past TTL.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A fresh insert should sweep the 10 expired entries first.
    await withCache('fresh', 30_000, async () => 'fresh');
    expect(_cacheSizeForTests()).toBe(1);
  });
});

describe('configCacheTtlMs', () => {
  it('defaults to 30 seconds', () => {
    delete process.env.CONFIG_CACHE_TTL_MS;
    expect(configCacheTtlMs()).toBe(30_000);
  });

  it('honours the env override', () => {
    process.env.CONFIG_CACHE_TTL_MS = '5000';
    expect(configCacheTtlMs()).toBe(5_000);
  });

  it('ignores negative or non-numeric overrides', () => {
    process.env.CONFIG_CACHE_TTL_MS = 'banana';
    expect(configCacheTtlMs()).toBe(30_000);
    process.env.CONFIG_CACHE_TTL_MS = '-100';
    expect(configCacheTtlMs()).toBe(30_000);
  });
});

describe('withCache — invalidation during an in-flight fetch', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('does not store a value whose fetch began before invalidatePrefix', async () => {
    const slow = deferred<string>();
    const first = withCache('setting:a:ctx1', 30_000, () => slow.promise);
    // An admin saves while the read is in flight.
    invalidatePrefix('setting:a:');
    slow.resolve('stale');
    // The caller that asked before the write still gets its answer…
    await expect(first).resolves.toBe('stale');
    // …but it is not cached for anyone else.
    const fresh = vi.fn().mockResolvedValue('fresh');
    await expect(withCache('setting:a:ctx1', 30_000, fresh)).resolves.toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('does not store a value whose fetch began before invalidate(key)', async () => {
    const slow = deferred<string>();
    const first = withCache('k', 30_000, () => slow.promise);
    invalidate('k');
    slow.resolve('stale');
    await first;
    const fresh = vi.fn().mockResolvedValue('fresh');
    await expect(withCache('k', 30_000, fresh)).resolves.toBe('fresh');
  });

  it('a caller arriving after the invalidation does not join the stale fetch', async () => {
    const slow = deferred<string>();
    const first = withCache('k', 30_000, () => slow.promise);
    invalidate('k');
    const fresh = vi.fn().mockResolvedValue('fresh');
    const second = withCache('k', 30_000, fresh);
    slow.resolve('stale');
    await expect(first).resolves.toBe('stale');
    await expect(second).resolves.toBe('fresh');
    // And the fresh value is the one that stuck.
    const third = vi.fn().mockResolvedValue('never');
    await expect(withCache('k', 30_000, third)).resolves.toBe('fresh');
    expect(third).not.toHaveBeenCalled();
  });

  it('leaves unrelated in-flight fetches cacheable', async () => {
    const slow = deferred<string>();
    const other = withCache('other:k', 30_000, () => slow.promise);
    invalidatePrefix('setting:');
    slow.resolve('v');
    await other;
    const again = vi.fn().mockResolvedValue('x');
    await expect(withCache('other:k', 30_000, again)).resolves.toBe('v');
    expect(again).not.toHaveBeenCalled();
  });

  it('dedupes concurrent misses on one key into a single fetch', async () => {
    const slow = deferred<string>();
    const fetcher = vi.fn(() => slow.promise);
    const a = withCache('k', 30_000, fetcher);
    const b = withCache('k', 30_000, fetcher);
    slow.resolve('v');
    await expect(Promise.all([a, b])).resolves.toEqual(['v', 'v']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares a rejection with joined callers and does not wedge the key', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue('ok');
    const a = withCache('k', 30_000, fetcher);
    const b = withCache('k', 30_000, fetcher);
    await expect(a).rejects.toThrow('db down');
    await expect(b).rejects.toThrow('db down');
    await expect(withCache('k', 30_000, fetcher)).resolves.toBe('ok');
  });
});
