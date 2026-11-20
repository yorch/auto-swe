import { describe, expect, it } from 'vitest';
import { type ActivityEventRow, ActivityQueue } from './activityEvents.js';

const ev = (kind: ActivityEventRow['kind'], actorId = 'u'): ActivityEventRow => ({
  actorId,
  ip: null,
  kind,
  method: 'AUTH',
  requestId: null,
  route: 'auth:password',
  status: null,
  via: 'session',
});

describe('auth events in the activity queue', () => {
  it('collapses a repeat within the dedupe window', () => {
    const queue = new ActivityQueue({ write: async () => {} });
    const dedupe = { key: 'sign_in|u|password', ttlMs: 60_000 };
    expect(queue.enqueue(ev('sign_in'), dedupe)).toBe(true);
    expect(queue.enqueue(ev('sign_in'), dedupe)).toBe(false);
    expect(queue.dropped).toBe(0);
  });

  it('gives each kind its own bucket and evicts ui before dropping a sign-in', () => {
    const queue = new ActivityQueue({
      actorEventsPerMinute: { sign_in_failed: 1 },
      batchSize: 1000,
      maxQueue: 1,
      write: async () => {},
    });
    expect(queue.enqueue(ev('ui'))).toBe(true);
    expect(queue.enqueue(ev('sign_in_failed'))).toBe(true);
    expect(queue.enqueue(ev('sign_in_failed'))).toBe(false);
    expect(queue.size).toBe(1);
  });
});
