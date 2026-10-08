import type { FastifyReply } from 'fastify';
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

/**
 * The gateway boots without Temporal and connects in the background, so for a
 * while after a start (or an outage at start) there is no client to ask.
 * Every `fastify.temporal.*` call made in that window rejects with this error.
 *
 * It is deliberately NOT a `WorkflowNotFoundError`: "not connected" says
 * nothing about whether an execution exists. `isTerminalSignalError` is false
 * for it (callers roll back and ask for a retry), `isWorkflowGone` and
 * `workflowSettledStatus` reject (callers read that as "could not confirm"),
 * and the global error handler answers it with a 503 and its own message.
 */
export const TEMPORAL_UNAVAILABLE_CODE = 'TEMPORAL_UNAVAILABLE';

export class TemporalUnavailableError extends Error {
  readonly code = TEMPORAL_UNAVAILABLE_CODE;
  readonly statusCode = 503;

  constructor() {
    super('Temporal is not connected yet; workflow operations are unavailable — retry shortly');
    this.name = 'TemporalUnavailableError';
  }
}

export function isTemporalUnavailable(err: unknown): err is TemporalUnavailableError {
  return err instanceof TemporalUnavailableError;
}

/** The 503 body for a Temporal that is not connected. */
export const TEMPORAL_UNAVAILABLE_BODY = {
  error: { code: TEMPORAL_UNAVAILABLE_CODE, message: new TemporalUnavailableError().message },
} as const;

/**
 * The one way a 503 for an unconnected Temporal is sent: the stable body and a
 * `Retry-After`. The global handler and every route that answers it itself use this.
 */
export function sendTemporalUnavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).header('Retry-After', '5').send(TEMPORAL_UNAVAILABLE_BODY);
}

/** Whether the background connection to Temporal is up (see `plugins/temporal.ts`). */
export function temporalConnected(app: {
  temporalConnection: { state: () => 'connecting' | 'connected' };
}): boolean {
  return app.temporalConnection.state() === 'connected';
}

/**
 * The global error handler's branch for a Temporal that is not connected: 503
 * with the stable code and a message that is safe to show (unlike other 5xx
 * messages, which are replaced by a generic one). Returns null for any other error.
 */
export function replyIfTemporalUnavailable(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (!isTemporalUnavailable(err)) {
    return null;
  }
  return sendTemporalUnavailable(reply);
}

/**
 * The `/health` body. Liveness stays 200 whatever Temporal is doing. `temporal`
 * says whether the first connection to Temporal has been made: `connected`
 * does not mean Temporal is reachable right now (the SDK reconnects on its own
 * and the gateway does not probe), and `connecting` means no workflow
 * operation can run yet.
 */
export function healthBody(connection: { state: () => 'connecting' | 'connected' }): {
  status: 'ok';
  temporal: 'connecting' | 'connected';
} {
  return { status: 'ok', temporal: connection.state() };
}
