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
  it('loads DB rows as labelled pattern sources', async () => {
    findMany.mockResolvedValue([row('rule-a', '\\bmkfs\\b'), row('rule-b', 'foo', 'i')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'test');
    const entries = await load();
    expect(entries).toEqual([
      { flags: '', label: 'rule-a', source: '\\bmkfs\\b' },
      { flags: 'i', label: 'rule-b', source: 'foo' },
    ]);
  });

  it('keeps an expensive-looking row rather than guessing it is unsafe', async () => {
    // The loader deliberately makes NO cost judgement: a pattern that shape
    // analysis would have called catastrophic still loads, and its execution
    // cost is bounded at run time by the executor's wall-clock budget. The
    // reverse — dropping it here — silently stops an admin's block rule.
    findMany.mockResolvedValue([row('redos', '(a+)+$'), row('ok', 'bar')] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'myScanner');
    const entries = await load();
    expect(entries.map((e) => e.label)).toEqual(['redos', 'ok']);
  });

  it('keeps an over-long row (the length cap is a write-time policy only)', async () => {
    // The old runtime check reported PATTERN_TOO_LONG *before* compiling, and the
    // runtime wrapper then discarded that code — so an over-long catastrophic row
    // written straight into the DB was compiled and run unchecked. There is no
    // longer a length-based runtime path to fail open.
    findMany.mockResolvedValue([row('long', `(a+)+${'b'.repeat(2100)}$`)] as never);
    const { load } = makePatternLoader('SHELL_COMMAND', 'myScanner');
    const entries = await load();
    expect(entries.map((e) => e.label)).toEqual(['long']);
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
