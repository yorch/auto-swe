import { beforeEach, describe, expect, it, vi } from 'vitest';

const find = vi.hoisted(() => vi.fn());
vi.mock('@auto-swe/shared/db', () => ({ prisma: { runInput: { findUnique: find } } }));

import { requestHasTrackerTicket } from './trackerTicket.js';

describe('requestHasTrackerTicket', () => {
  beforeEach(() => find.mockClear());

  it('is false for an id the platform generated', async () => {
    find.mockResolvedValue({ ticketIsSynthetic: true });
    expect(await requestHasTrackerTicket('wr-1', 'PRD-1-1')).toBe(false);
  });

  it('is true for a tracker or user supplied id', async () => {
    find.mockResolvedValue({ ticketIsSynthetic: false });
    expect(await requestHasTrackerTicket('wr-1', 'PROJ-1')).toBe(true);
  });
});
