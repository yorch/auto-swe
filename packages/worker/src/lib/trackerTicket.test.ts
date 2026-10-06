import { beforeEach, describe, expect, it, vi } from 'vitest';

const find = vi.hoisted(() => vi.fn());
vi.mock('@auto-swe/shared/db', () => ({ prisma: { runInput: { findUnique: find } } }));

import { requestHasTrackerTicket, requestTicketIsSynthetic } from './trackerTicket.js';

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

  it('is true when the flag cannot be read, as the tracker sync is best-effort', async () => {
    find.mockRejectedValue(new Error('down'));
    expect(await requestHasTrackerTicket('wr-1', 'PROJ-1')).toBe(true);
    find.mockResolvedValue(null);
    expect(await requestHasTrackerTicket('wr-1', 'PROJ-1')).toBe(true);
  });
});

describe('requestTicketIsSynthetic', () => {
  it('is null, not false, when it cannot tell', async () => {
    find.mockRejectedValue(new Error('down'));
    expect(await requestTicketIsSynthetic('wr-1')).toBeNull();
    find.mockResolvedValue(null);
    expect(await requestTicketIsSynthetic('wr-1')).toBeNull();
    find.mockResolvedValue({ ticketIsSynthetic: false });
    expect(await requestTicketIsSynthetic('wr-1')).toBe(false);
  });
});
