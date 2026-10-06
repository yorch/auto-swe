import { prisma } from '@auto-swe/shared/db';
import { isTrackerTicket } from '@auto-swe/shared/lib/trackerSync';

/**
 * Whether the platform generated a request's ticket id (`RunInput.ticketIsSynthetic`),
 * or null when that could not be read (no such row, or the lookup failed).
 */
export async function requestTicketIsSynthetic(workRequestId: string): Promise<boolean | null> {
  try {
    const row = await prisma.runInput.findUnique({
      select: { ticketIsSynthetic: true },
      where: { id: workRequestId },
    });
    return row ? row.ticketIsSynthetic : null;
  } catch {
    return null;
  }
}

/**
 * Whether a run's ticket id names a tracker issue, for the activities that hold only
 * the request. A lookup that fails answers yes: the sync is best-effort and the
 * historical behaviour is to attempt it.
 */
export async function requestHasTrackerTicket(
  workRequestId: string,
  externalTicketId: string
): Promise<boolean> {
  return isTrackerTicket({
    externalTicketId,
    ticketIsSynthetic: await requestTicketIsSynthetic(workRequestId),
  });
}
