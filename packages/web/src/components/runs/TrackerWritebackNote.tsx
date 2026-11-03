import { readTrackerWriteback } from '@auto-swe/shared/lib/integrations/ticketFailure';
import { Alert } from '@/components/ui/Alert';

/**
 * Why a run could not update its ticket when it ended (the comment of a run that did not finish,
 * or the status move of one that did; a link is only written when a PR url is supplied, which
 * the run's end does not do), by the class the run recorded, in words that
 * name the next step and fit either write. A lookup table, never the stored value, so
 * nothing a run produced is shown beyond a known class. Its keys are the `TicketFailureClass`
 * set (a test fails when they drift apart).
 */
export const TRACKER_WRITE_LINES = new Map<string, string>([
  ['unauthorized', 'the tracker rejected its credentials; ask an administrator to check them'],
  [
    'forbidden',
    'access was refused; ask an administrator to check the tracker credentials and that the account may update this ticket',
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
  ['empty', 'there was nothing to post'],
  [
    'out_of_scope',
    'the ticket is in a repository this run does not target, so the platform did not write to it',
  ],
  [
    'no_repository',
    'the platform could not resolve a repository from the ticket id, so it did not write to it',
  ],
  [
    'no_transition',
    'no transition to a status named like the one the platform looks for was found on the ticket (the project may name its statuses differently)',
  ],
  ['unknown', 'the reason is not known'],
]);

// The classes for which the platform knows nothing was written. For `no_transition` that holds only
// because `finalizeRun`, the sole recorder of a write-back, sends no `prUrl`: with one, a Jira
// remote link could succeed before the move is found missing. Revisit this set if that changes.
const NOTHING_WRITTEN = new Set(['out_of_scope', 'no_repository', 'no_transition']);

/** The notice that a run could not report its end back to its ticket. */
export function TrackerWritebackNote({ contextSnapshot }: { contextSnapshot: unknown }) {
  const writeback = readTrackerWriteback(contextSnapshot);
  const reason = writeback ? TRACKER_WRITE_LINES.get(writeback.failure) : undefined;
  if (!writeback || !reason) {
    return null;
  }
  return (
    <Alert announce={false} title="The ticket was not updated" variant="warning">
      {writeback.event === 'workflow_completed'
        ? `The run finished, but the ticket could not be updated (${reason}).${
            // For these the platform knows nothing was written, so nothing is in doubt.
            NOTHING_WRITTEN.has(writeback.failure) ? '' : ' Its status may not have been moved on.'
          }`
        : `The comment saying the run did not finish could not be posted (${reason}). Anyone watching the ticket has not been told.`}
    </Alert>
  );
}
