import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: async () => 7 }));

import {
  createNotificationPoller,
  POLL_INTERVAL_MS,
  PURGE_INTERVAL_MS,
  startJoinRequestNotificationPoller,
} from './joinRequestNotificationPoller.js';

describe('the poller purges for retention at most once a minute', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims on every tick but scans for old rows once per purge interval', async () => {
    vi.useFakeTimers();
    const purgeScans = vi.fn(async () => []);
    const prisma = {
      $transaction: vi.fn(async () => []),
      joinRequestNotification: { deleteMany: vi.fn(), findMany: purgeScans },
    };
    const fastify = { log: { error: vi.fn() }, prisma } as unknown as FastifyInstance;
    const poller = startJoinRequestNotificationPoller(fastify, { firstDelayMs: 1 });
    poller.start();

    // Three minutes of ticks, one every POLL_INTERVAL_MS.
    const total = 3 * PURGE_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(total);
    await poller.stop();

    const ticks = prisma.$transaction.mock.calls.length;
    expect(ticks).toBeGreaterThanOrEqual(total / POLL_INTERVAL_MS - 1);
    // The first tick purges, then one more per minute: never one per tick.
    expect(purgeScans.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(purgeScans.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

describe('a stopping poller tells the tick that is running', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the tick a flag that turns true on stop, and schedules nothing after it', async () => {
    vi.useFakeTimers();
    let seen: (() => boolean) | undefined;
    let finish: () => void = () => undefined;
    const tick = vi.fn(async (stopping: () => boolean) => {
      seen = stopping;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        claimed: 0,
        delivered: 0,
        failed: 0,
        leaseLost: 0,
        purged: 0,
        released: 0,
        skipped: 0,
      };
    });
    const poller = createNotificationPoller({
      batchSize: 20,
      firstDelayMs: 1,
      intervalMs: 5,
      log: { error: vi.fn() },
      tick,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(2);
    expect(seen?.()).toBe(false);
    const stopped = poller.stop();
    expect(seen?.()).toBe(true);
    finish();
    await stopped;
    await vi.advanceTimersByTimeAsync(100);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
