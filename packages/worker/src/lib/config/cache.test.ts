import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _cacheSizeForTests,
  _resetConfigCacheForTests,
  configCacheTtlMs,
  invalidate,
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

  it('re-fetches after TTL expires', async () => {
    // Real timers with a tiny TTL — fake timers + async resolver can race on
    // CI runners (we've seen unexplained intermittent failures under
    // Node 24 + fake-timer-driven cache tests).
    const fetcher = vi.fn().mockResolvedValueOnce('v1').mockResolvedValueOnce('v2');
    await withCache('k', 10, fetcher);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const r = await withCache('k', 10, fetcher);
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
      await withCache(k, 10, async () => k);
    }
    expect(_cacheSizeForTests()).toBe(10);

    // Wait past TTL.
    await new Promise((resolve) => setTimeout(resolve, 30));

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
