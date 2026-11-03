/**
 * Why a tracker ticket could not be read. A closed set on purpose: the class is stored on traces
 * and step outputs and shown to people, so it never carries provider error text, a response
 * body, a URL, a token or a header. `out_of_scope`, `no_repository` and `no_transition` are only
 * ever writes, and the platform knows nothing was written (for `no_transition` only because
 * `finalizeRun`, the sole recorder, sends no `prUrl`; a Jira remote link could otherwise succeed
 * first): `out_of_scope` declined a GitHub ticket
 * in a repository the run does not target, `no_repository` a GitHub ticket id the platform could
 * not resolve a repository from (a bare `123`, an issue URL, `owner/repo`, or another tracker's
 * key), and `no_transition` is a Jira ticket on which no transition to a status
 * named like the target was found (the platform looks for a fixed name, and the project may name
 * its done status differently, so this is not a claim about the workflow). A read never produces them.
 * `not_found` is deliberately ambiguous: trackers answer 404
 * both for an issue that does not exist and for one the token may not see.
 */
export const TICKET_FAILURE_CLASSES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'server_error',
  'timeout',
  'network',
  'redirect',
  'rejected',
  'refused',
  'unconfigured',
  'empty',
  'out_of_scope',
  'no_repository',
  'no_transition',
  'unknown',
] as const;

export type TicketFailureClass = (typeof TICKET_FAILURE_CLASSES)[number];

/**
 * The class for an HTTP status a tracker answered with: 5xx is `server_error`, any 4xx without a
 * class of its own is `rejected` (the tracker refused the request itself), anything else `unknown`.
 * `refused` is the platform's own network policy and has no status.
 */
export function ticketFailureFromStatus(status: number): TicketFailureClass {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  if (status >= 300 && status < 400) {
    return 'redirect';
  }
  if (status >= 500) {
    return 'server_error';
  }
  return status >= 400 ? 'rejected' : 'unknown';
}

/** True for the rejection `AbortSignal.timeout()` produces, as thrown or as a `fetch` cause. */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === 'TimeoutError' || isTimeoutError(err.cause);
}

/** The run events whose tracker write-back failure is recorded on the run. */
export const TRACKER_WRITEBACK_EVENTS = ['workflow_completed', 'workflow_failed'] as const;

export type TrackerWritebackEvent = (typeof TRACKER_WRITEBACK_EVENTS)[number];

/**
 * The first write a run's tracker sync made when it ended and the tracker refused: the comment
 * saying the run did not finish (`workflow_failed`), or the status move of a run that finished
 * (`workflow_completed`; a link is written only when a PR url is supplied, which `finalizeRun`
 * does not do). Stored on the run's `contextSnapshot` as `trackerWriteback`, so
 * a run that could not report back to its ticket says so. The failure is from the closed set
 * {@link TicketFailureClass}: never provider text. A ticket already in the target status
 * has no transition to it and is not recorded; one with no transition to a status named
 * like it is `no_transition`.
 */
// A type alias, not an interface: only an alias is assignable to Prisma's JSON input type.
export type TrackerWriteback = { event: TrackerWritebackEvent; failure: TicketFailureClass };

/**
 * The write-back failure on a run snapshot, or null when it holds none or holds anything else.
 * A record stored before the event was kept has none and is a `workflow_failed` one (the only
 * event recorded then); an event that is present but unknown reads as null.
 */
export function readTrackerWriteback(snapshot: unknown): TrackerWriteback | null {
  if (typeof snapshot !== 'object' || snapshot === null) {
    return null;
  }
  const record: unknown = (snapshot as { trackerWriteback?: unknown }).trackerWriteback;
  if (typeof record !== 'object' || record === null) {
    return null;
  }
  const { event, failure } = record as { event?: unknown; failure?: unknown };
  if (
    typeof failure !== 'string' ||
    !(TICKET_FAILURE_CLASSES as readonly string[]).includes(failure)
  ) {
    return null;
  }
  if (event === undefined) {
    return { event: 'workflow_failed', failure: failure as TicketFailureClass };
  }
  if (
    typeof event !== 'string' ||
    !(TRACKER_WRITEBACK_EVENTS as readonly string[]).includes(event)
  ) {
    return null;
  }
  return { event: event as TrackerWritebackEvent, failure: failure as TicketFailureClass };
}
