import { describe, expect, it } from 'vitest';
import {
  orderReviewQueue,
  type QueueItem,
  reviewBatchOf,
  summarizeReviewQueue,
} from './reviewQueue.js';
import type { RoutingDecision } from './reviewRouting.js';

const human: RoutingDecision = {
  matchedPath: null,
  needsHuman: true,
  reason: 'risk',
  reasons: ['risk'],
};
const nobody: RoutingDecision = {
  matchedPath: null,
  needsHuman: false,
  reason: 'draft',
  reasons: ['draft'],
};

const item = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({
  changedLines: 50,
  decision: human,
  id,
  openedAt: new Date('2026-11-01T00:00:00Z'),
  quickReviewMaxLines: 100,
  riskClass: 'LOW',
  ...over,
});

describe('reviewBatchOf', () => {
  it('batches by need, risk and size', () => {
    expect(reviewBatchOf(item('a', { decision: nobody }))).toBe('none');
    expect(reviewBatchOf(item('a', { riskClass: 'HIGH' }))).toBe('deep');
    expect(reviewBatchOf(item('a', { riskClass: null }))).toBe('deep');
    expect(reviewBatchOf(item('a', { riskClass: 'STANDARD' }))).toBe('standard');
    expect(reviewBatchOf(item('a', { changedLines: 100 }))).toBe('quick');
    expect(reviewBatchOf(item('a', { changedLines: 101 }))).toBe('standard');
    expect(reviewBatchOf(item('a', { changedLines: null }))).toBe('standard');
  });
});

describe('orderReviewQueue', () => {
  it('puts deep review first, then standard, quick, and what needs nobody last', () => {
    const order = orderReviewQueue([
      item('none', { decision: nobody }),
      item('quick'),
      item('standard', { riskClass: 'STANDARD' }),
      item('deep', { riskClass: 'HIGH' }),
    ]);
    expect(order.map((e) => [e.id, e.batch, e.position])).toEqual([
      ['deep', 'deep', 1],
      ['standard', 'standard', 2],
      ['quick', 'quick', 3],
      ['none', 'none', 4],
    ]);
  });

  it('reads an unevaluated pull request as the highest risk, ahead of a HIGH one', () => {
    const order = orderReviewQueue([
      item('high', { openedAt: new Date('2026-11-01T00:00:00Z'), riskClass: 'HIGH' }),
      item('unknown', { openedAt: new Date('2026-11-02T00:00:00Z'), riskClass: null }),
    ]);
    // Equal rank, so the longer wait comes first.
    expect(order.map((e) => e.id)).toEqual(['high', 'unknown']);
  });

  it('orders the longest-waiting first inside a batch, and the smallest first among quick ones', () => {
    const old = new Date('2026-10-01T00:00:00Z');
    const newer = new Date('2026-11-01T00:00:00Z');
    expect(
      orderReviewQueue([
        item('new', { openedAt: newer, riskClass: 'STANDARD' }),
        item('old', { openedAt: old, riskClass: 'STANDARD' }),
      ]).map((e) => e.id)
    ).toEqual(['old', 'new']);
    expect(
      orderReviewQueue([
        item('big', { changedLines: 90, openedAt: old }),
        item('small', { changedLines: 5, openedAt: newer }),
      ]).map((e) => e.id)
    ).toEqual(['small', 'big']);
  });

  it('is total: equal items fall back to the id', () => {
    expect(orderReviewQueue([item('b'), item('a')]).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('summarizeReviewQueue', () => {
  it('counts batches and the wait of what needs a person', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const summary = summarizeReviewQueue(
      [
        item('a', { openedAt: new Date('2026-11-01T00:00:00Z'), riskClass: 'HIGH' }),
        item('b', { openedAt: new Date('2026-11-01T12:00:00Z') }),
        item('c', { decision: nobody, openedAt: new Date('2026-10-01T00:00:00Z') }),
      ],
      now
    );
    expect(summary).toEqual({
      batches: { deep: 1, none: 1, quick: 1, standard: 0 },
      medianWaitingMs: 64_800_000,
      needsHuman: 2,
      oldestWaitingMs: 86_400_000,
      open: 3,
    });
  });

  it('reports no wait for an empty queue', () => {
    expect(summarizeReviewQueue([], new Date()).oldestWaitingMs).toBeNull();
  });
});
