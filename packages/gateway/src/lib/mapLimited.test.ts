import { describe, expect, it } from 'vitest';
import { mapLimited } from './mapLimited.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('mapLimited', () => {
  it('maps every item in input order with at most `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it('starts no new call once one has failed, and rejects with the first error', async () => {
    const started: number[] = [];
    const items = Array.from({ length: 50 }, (_, i) => i);
    const run = mapLimited(items, 3, async (n) => {
      started.push(n);
      if (n === 1) {
        throw new Error('first');
      }
      await tick();
      if (n === 2) {
        throw new Error('second');
      }
      return n;
    });
    await expect(run).rejects.toThrow('first');
    // Let the surviving worker finish its call; it must not pull another item.
    await tick();
    await tick();
    expect(started.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});
