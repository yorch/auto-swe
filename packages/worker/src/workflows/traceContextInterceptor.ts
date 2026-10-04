import {
  defaultPayloadConverter,
  type Payload,
  type WorkflowInterceptors,
  workflowInfo,
} from '@temporalio/workflow';

/**
 * Same name as `TRACE_CONTEXT_HEADER` in `@auto-swe/shared/lib/temporalTracing`,
 * which the isolate cannot import (it loads OpenTelemetry). A test asserts the
 * two agree.
 */
export const TRACE_CONTEXT_HEADER = 'x-auto-swe-trace';

/** Same as `TRACE_SIGNAL_HEADER` in `@auto-swe/shared/lib/temporalTracing`. */
export const TRACE_SIGNAL_HEADER = 'x-auto-swe-trace-signal';

/**
 * 128 bits from a string, as 32 hex digits — four independently seeded 32-bit
 * mixes (cyrb128). Pure arithmetic, so it is identical on every replay.
 */
function hash128(text: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4].map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * The carrier for a run nobody gave a trace context — one started by a
 * Temporal Schedule. The trace id is a hash of the run chain's identity, so
 * every activity of the run (continuations and children included, since they
 * carry this header on) lands in one trace instead of one root trace each.
 * There is no parent span: the first span in the trace is a root.
 */
function derivedCarrier(): Payload {
  const { workflowId, firstExecutionRunId } = workflowInfo();
  const hex = hash128(`${workflowId}/${firstExecutionRunId}`);
  const traceparent = `00-${hex}-${hex.slice(0, 16)}-01`;
  return defaultPayloadConverter.toPayload({ traceparent });
}

/**
 * Workflow interceptor: forward the trace context the workflow was started with
 * to everything it schedules — activities, local activities, child workflows,
 * and its own continuation — so a gateway request and every activity of the
 * run it started share one trace.
 *
 * Pure header passing: a received payload is copied, never decoded, and
 * no OpenTelemetry code runs in the isolate. The one payload built here is the
 * derived carrier for a run started without a context. Headers are not part of the
 * command stream Temporal compares on replay, so recorded histories replay
 * unchanged (`runnable.traceContext.replay.test.ts`). A header already set by
 * the caller wins.
 */
export const interceptors = (): WorkflowInterceptors => {
  let carried: Payload | undefined;
  // The newest signal or update's context. Activities scheduled after it link
  // to it (the signal's own trace is not theirs to join), so work that follows
  // an approval can be reached from the approval request.
  let signalCarried: Payload | undefined;
  const forward = <T extends { headers: Record<string, Payload> }>(input: T): T => {
    const headers = { ...input.headers };
    if (carried && !headers[TRACE_CONTEXT_HEADER]) {
      headers[TRACE_CONTEXT_HEADER] = carried;
    }
    if (signalCarried && !headers[TRACE_SIGNAL_HEADER]) {
      headers[TRACE_SIGNAL_HEADER] = signalCarried;
    }
    return { ...input, headers };
  };

  return {
    inbound: [
      {
        execute(input, next) {
          carried = input.headers[TRACE_CONTEXT_HEADER] ?? derivedCarrier();
          return next(input);
        },
        handleSignal(input, next) {
          signalCarried = input.headers[TRACE_CONTEXT_HEADER] ?? signalCarried;
          return next(input);
        },
        handleUpdate(input, next) {
          signalCarried = input.headers[TRACE_CONTEXT_HEADER] ?? signalCarried;
          return next(input);
        },
      },
    ],
    outbound: [
      {
        continueAsNew: (input, next) => next(forward(input)),
        scheduleActivity: (input, next) => next(forward(input)),
        scheduleLocalActivity: (input, next) => next(forward(input)),
        startChildWorkflowExecution: (input, next) => next(forward(input)),
      },
    ],
  };
};
