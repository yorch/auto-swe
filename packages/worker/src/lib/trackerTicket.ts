import { prisma } from '@auto-swe/shared/db';
import { isTrackerTicket } from '@auto-swe/shared/lib/trackerSync';

/**
 * Whether a run's ticket id names a tracker issue, for the activities that hold only
 * the request. A lookup that fails answers yes: the sync is best-effort and the
 * historical behaviour is to attempt it.
 */
export async function requestHasTrackerTicket(
  workRequestId: string,
  externalTicketId: string
): Promise<boolean> {
  try {
    const row = await prisma.runInput.findUnique({
      select: { ticketIsSynthetic: true },
      where: { id: workRequestId },
    });
    return isTrackerTicket({ externalTicketId, ticketIsSynthetic: row?.ticketIsSynthetic });
  } catch {
    return true;
  }
}
