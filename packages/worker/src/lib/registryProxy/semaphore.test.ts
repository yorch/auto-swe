import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands out its limit at once and queues the rest in order', async () => {
    const sem = new Semaphore(2, 2, 1_000);
    const a = await sem.acquire();
    const b = await sem.acquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    const order: string[] = [];
    const c = sem.acquire().then((r) => {
      order.push('c');
      return r;
    });
    const d = sem.acquire().then((r) => {
      order.push('d');
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    a?.();
    expect(await c).toBeTypeOf('function');
    expect(order).toEqual(['c']);
    b?.();
    expect(await d).toBeTypeOf('function');
    expect(order).toEqual(['c', 'd']);
  });

  it('refuses a caller when the queue is full', async () => {
    const sem = new Semaphore(1, 1, 1_000);
    await sem.acquire();
    void sem.acquire();
    expect(await sem.acquire()).toBeNull();
  });

  it('gives up a waiter after the wait and frees its place in the queue', async () => {
    const sem = new Semaphore(1, 1, 1_000);
    const held = await sem.acquire();
    const waiting = sem.acquire();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await waiting).toBeNull();
    // The queue has room again, and the held permit still returns to the pool.
    const next = sem.acquire();
    held?.();
    expect(await next).toBeTypeOf('function');
  });

  it('releases a permit once, however often the release is called', async () => {
    const sem = new Semaphore(1, 1, 1_000);
    const held = await sem.acquire();
    held?.();
    held?.();
    expect(await sem.acquire()).toBeTypeOf('function');
    // Only one permit exists, so the next caller queues rather than getting a second.
    const queued = sem.acquire();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await queued).toBeNull();
  });

  it('turns waiters and later callers away once closed', async () => {
    const sem = new Semaphore(1, 4, 60_000);
    await sem.acquire();
    const waiting = sem.acquire();
    sem.close();
    expect(await waiting).toBeNull();
    expect(await sem.acquire()).toBeNull();
  });
});
