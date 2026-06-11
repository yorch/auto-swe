import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    scannerPattern: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { makePatternLoader } from './scannerPatternLoader.js';

const findMany = vi.mocked(prisma.scannerPattern.findMany);

function row(label: string, pattern: string, flags = '') {
  return { flags, id: `id-${label}`, isActive: true, label, pattern, type: 'SHELL_COMMAND' };
}

beforeEach(() => {
  findMany.mockReset();
});

describe('makePatternLoader — loading and compilation', () => {
  it('compiles DB rows into labelled RegExp entries', async () => {
    findMany.mockResolvedValue([row('rule-a', '\\bmkfs\\b'), row('rule-b', 'foo', 'i')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    const entries = await load();
    expect(entries).toHaveLength(2);
    expect(entries[0].label).toBe('rule-a');
    expect(entries[0].re).toBeInstanceOf(RegExp);
    expect(entries[0].re.source).toBe('\\bmkfs\\b');
    expect(entries[1].re.flags).toBe('i');
    expect(entries[1].re.test('FOO')).toBe(true);
  });

  it('queries only active patterns of the requested type, ordered by label', async () => {
    findMany.mockResolvedValue([] as never);
    const { load } = makePatternLoader('CODE_SECURITY', 'test');
    await load();
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { label: 'asc' },
      where: { isActive: true, type: 'CODE_SECURITY' },
    });
  });

  it('skips rows with invalid regexes and keeps the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      findMany.mockResolvedValue([row('broken', '('), row('ok', 'bar')] as never);
      const { load } = makePatternLoader('SHELL_COMMAND', 'myScanner');
      const entries = await load();
      expect(entries.map((e) => e.label)).toEqual(['ok']);
      expect(errorSpy).toHaveBeenCalledWith(
        "[myScanner] skipping invalid pattern 'broken': invalid regex"
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('propagates DB errors and retries on the next call (no poisoned cache)', async () => {
    findMany.mockRejectedValueOnce(new Error('db down'));
    findMany.mockResolvedValue([row('ok', 'bar')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    await expect(load()).rejects.toThrow('db down');
    const entries = await load();
    expect(entries.map((e) => e.label)).toEqual(['ok']);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('makePatternLoader — TTL cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves repeat loads from cache within the TTL', async () => {
    findMany.mockResolvedValue([row('a', 'x')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    const first = await load();
    vi.advanceTimersByTime(59_999);
    const second = await load();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same cached array instance
  });

  it('refetches once the 60s TTL has elapsed', async () => {
    findMany.mockResolvedValue([row('a', 'x')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    await load();
    vi.advanceTimersByTime(60_000);
    await load();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('caches an empty pattern list too', async () => {
    findMany.mockResolvedValue([] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    await expect(load()).resolves.toEqual([]);
    await expect(load()).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a refetch even within the TTL', async () => {
    findMany.mockResolvedValue([row('a', 'x')] as never);
    const { invalidate, load } = makePatternLoader('SHELL_COMMAND', 'test');
    await load();
    invalidate();
    await load();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('keeps caches isolated between loader instances', async () => {
    findMany.mockResolvedValue([] as never);
    const loaderA = makePatternLoader('SHELL_COMMAND', 'a');
    const loaderB = makePatternLoader('SENSITIVE_FILE', 'b');

    await loaderA.load();
    await loaderB.load();
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      orderBy: { label: 'asc' },
      where: { isActive: true, type: 'SHELL_COMMAND' },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      orderBy: { label: 'asc' },
      where: { isActive: true, type: 'SENSITIVE_FILE' },
    });

    // Invalidating A must not evict B's cache.
    loaderA.invalidate();
    await loaderB.load();
    expect(findMany).toHaveBeenCalledTimes(2);
    await loaderA.load();
    expect(findMany).toHaveBeenCalledTimes(3);
  });
});
