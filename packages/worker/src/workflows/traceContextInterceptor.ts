import {
  CancelledFailure,
  ContinueAsNew,
  defaultPayloadConverter,
  type Payload,
  proxySinks,
  TemporalFailure,
  type WorkflowInterceptors,
  workflowInfo,
} from '@temporalio/workflow';
import {
  type WorkflowSpanOutcome,
  type WorkflowSpanSinks,
  workflowSpanContext,
} from './workflowSpan.js';

/**
 * Same name as `TRACE_CONTEXT_HEADER` in `@auto-swe/shared/lib/temporalTracing`,
 * which the isolate cannot import (it loads OpenTelemetry). A test asserts the
 * two agree.
 */
export const TRACE_CONTEXT_HEADER = 'x-auto-swe-trace';

/** Same as `TRACE_SIGNAL_HEADER` in `@auto-swe/shared/lib/temporalTracing`. */
export const TRACE_SIGNAL_HEADER = 'x-auto-swe-trace-signal';

function decodeCarrier(payload: Payload | undefined): Record<string, string> | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    const value = defaultPayloadConverter.fromPayload<unknown>(payload);
    return value && typeof value === 'object' ? (value as Record<string, string>) : undefined;
  } catch {
    // A header this worker cannot decode only costs the link: the run gets a derived trace.
    return undefined;
  }
}

/**
 * How a run ended, as workflow code can see it. Only a `TemporalFailure` (or a
 * continue-as-new) ends the run: any other thrown error fails the workflow
 * *task*, which Temporal retries, so it is not an end and exports nothing.
 */
function classify(err: unknown): { outcome: WorkflowSpanOutcome; message?: string } | undefined {
  if (err instanceof ContinueAsNew) {
    return { outcome: 'continued-as-new' };
  }
  if (err instanceof CancelledFailure) {
    return { outcome: 'cancelled' };
  }
  if (err instanceof TemporalFailure) {
    return { message: err.message, outcome: 'failed' };
  }
  return undefined;
}

/**
 * Workflow interceptor: give each run a workflow span and forward the trace
 * context, re-parented on it, to everything the run schedules — activities,
 * local activities, child workflows, and its own continuation — so a gateway
 * request, the workflow, and every activity of the run share one trace as
 * starter → workflow → activity.
 *
 * No OpenTelemetry code runs in the isolate. The span's id is derived by
 * arithmetic from the workflow id and run id (`workflowSpan.ts`), so every
 * replay computes the same one; the carrier is decoded and rebuilt as plain
 * JSON. The span itself is exported outside the isolate: when the run's
 * workflow code ends, the interceptor hands a plain record to the
 * `workflowSpans` sink (`callDuringReplay: false`, see `lib/workflowSpanSink.ts`),
 * which builds and exports the span with exactly those ids. Headers and sink
 * calls are not part of the command stream Temporal compares on replay, so
 * recorded histories replay unchanged (`runnable.traceContext.replay.test.ts`).
 * A header already set by the caller wins.
 */
export const interceptors = (): WorkflowInterceptors => {
  const { workflowSpans } = proxySinks<WorkflowSpanSinks>();
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
        async execute(input, next) {
          const { workflowId, runId, firstExecutionRunId, runStartTime } = workflowInfo();
          const span = workflowSpanContext(
            decodeCarrier(input.headers[TRACE_CONTEXT_HEADER]),
            workflowId,
            runId,
            firstExecutionRunId
          );
          carried = defaultPayloadConverter.toPayload(span.carrier);
          // A child or continuation inherits the parent's newest signal link.
          signalCarried = input.headers[TRACE_SIGNAL_HEADER];
          const end = (ended: ReturnType<typeof classify>) => {
            if (!ended) {
              return;
            }
            workflowSpans.exportSpan({
              endTimeMs: Date.now(),
              ...(ended.message ? { errorMessage: ended.message } : {}),
              flags: span.flags,
              outcome: ended.outcome,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              spanId: span.spanId,
              startTimeMs: runStartTime.getTime(),
              traceId: span.traceId,
            });
          };
          try {
            const result = await next(input);
            end({ outcome: 'completed' });
            return result;
          } catch (err) {
            end(classify(err));
            throw err;
          }
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
