import { readTrackerWriteback } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { Alert } from '@/components/ui/Alert';

/**
 * Why the tracker refused the comment a run posts to its ticket when it ends, by the class the
 * run recorded, in words that name the next step. A lookup table, never the stored value, so
 * nothing a run produced is shown beyond a known class. Its keys are the `TicketFailureClass`
 * set (a test fails when they drift apart).
 */
export const TRACKER_WRITE_LINES = new Map<string, string>([
  ['unauthorized', 'the tracker rejected its credentials; ask an administrator to check them'],
  [
    'forbidden',
    'access was refused; ask an administrator to check the tracker credentials and that the account may comment on this ticket',
  ],
  ['not_found', 'access was refused, or the ticket does not exist'],
  ['rate_limited', 'the tracker is limiting requests'],
  ['server_error', 'the tracker returned an error'],
  ['timeout', 'the tracker did not answer in time'],
  ['network', 'the tracker could not be reached'],
  ['redirect', 'the tracker address redirects, which is not followed'],
  ['rejected', 'the tracker rejected the request; check the ticket id'],
  [
    'refused',
    "the platform's network policy blocked it; ask an administrator to check the tracker's allowed addresses",
  ],
  ['unconfigured', 'no ticket tracker is configured'],
  ['empty', 'the comment was empty'],
  ['unknown', 'the reason is not known'],
]);

/** The notice that a run which did not finish could not report back to its ticket. */
export function TrackerWritebackNote({ contextSnapshot }: { contextSnapshot: unknown }) {
  const writeback = readTrackerWriteback(contextSnapshot);
  const reason = writeback ? TRACKER_WRITE_LINES.get(writeback.failure) : undefined;
  if (!reason) {
    return null;
  }
  return (
    <Alert announce={false} title="The ticket was not updated" variant="warning">
      The comment saying the run did not finish could not be posted ({reason}). Anyone watching the
      ticket has not been told.
    </Alert>
  );
}
