/**
 * Why a tracker ticket could not be read. A closed set on purpose: the class is stored on traces
 * and step outputs and shown to people, so it never carries provider error text, a response
 * body, a URL, a token or a header. `not_found` is deliberately ambiguous: trackers answer 404
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
