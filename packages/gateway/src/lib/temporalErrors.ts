import { getErrorName } from '../plugins/auth.js';

/**
 * True when a Temporal signal rejection can never succeed on a later attempt:
 * the target execution does not exist, because it never started or has already
 * completed / been terminated.
 *
 * The distinction matters wherever a signal is delivered *after* a DB write that
 * describes the same decision. On a TRANSIENT failure the write is undone so a
 * retry — a GitHub redelivery, a human pressing the button again — can land the
 * signal and unblock the run. On a TERMINAL one there is no run left to strand
 * and no retry can ever succeed, so undoing the write would only leave the DB
 * describing reality incorrectly and invite an unclearable retry loop: the write
 * stands and the caller reports success-with-caveat (`signalSent: false`).
 *
 * Shared by `routes/webhooks.ts` (PR merge / CI verdicts), `routes/slack.ts`
 * (thread steering), and `lib/hitlResolve.ts` (inbox + Slack HITL resolve) so
 * the three cannot disagree about which failures are worth retrying.
 */
export function isTerminalSignalError(err: unknown): boolean {
  return getErrorName(err) === 'WorkflowNotFoundError';
}
