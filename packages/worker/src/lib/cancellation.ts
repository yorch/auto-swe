import { Context } from '@temporalio/activity';

/**
 * Activity cancellation, observed.
 *
 * Temporal delivers an activity cancellation through the heartbeat response:
 * the worker aborts `Context.current().cancellationSignal` (with a
 * `CancelledFailure` as its reason) the next time a heartbeat reaches the
 * server. Nothing stops the activity on its own — code that never looks at the
 * signal keeps running to completion after the workflow has moved on, pushing
 * a branch nobody asked for. So a cancellable activity must both heartbeat
 * (see `withHeartbeat` in `execUtils.ts`) and consult the signal at its
 * checkpoints: hand it to the LLM call, and check it before any step with an
 * external side effect.
 *
 * Every helper here is a no-op outside an activity context (unit tests, the
 * eval harness run in-process), so callers need no guard of their own.
 */

/** The current activity's cancellation signal, or undefined outside an activity. */
export function activityCancellationSignal(): AbortSignal | undefined {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
}

/**
 * Throw the activity's cancellation reason (a `CancelledFailure`) if the
 * activity has been cancelled. Call it between loop iterations and right
 * before an irreversible step such as `git push`.
 */
export function throwIfActivityCancelled(): void {
  activityCancellationSignal()?.throwIfAborted();
}

/**
 * `{ abortSignal }` for a Mastra `generate`/`stream` options object, so an
 * in-flight LLM call (and its tool loop) stops when the activity is
 * cancelled. Spread it: outside an activity it is `{}` and changes nothing.
 */
export function abortSignalOption(): { abortSignal?: AbortSignal } {
  const signal = activityCancellationSignal();
  return signal ? { abortSignal: signal } : {};
}
