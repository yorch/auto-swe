import type { Payload, WorkflowInterceptors } from '@temporalio/workflow';

/**
 * Same name as `TRACE_CONTEXT_HEADER` in `@auto-swe/shared/lib/temporalTracing`,
 * which the isolate cannot import (it loads OpenTelemetry). A test asserts the
 * two agree.
 */
export const TRACE_CONTEXT_HEADER = 'x-auto-swe-trace';

/**
 * Workflow interceptor: forward the trace context the workflow was started with
 * to everything it schedules — activities, local activities, child workflows,
 * and its own continuation — so a gateway request and every activity of the
 * run it started share one trace.
 *
 * Pure header passing: the payload is copied as received, never decoded, and
 * no OpenTelemetry code runs in the isolate. Headers are not part of the
 * command stream Temporal compares on replay, so recorded histories replay
 * unchanged (`runnable.traceContext.replay.test.ts`). A header already set by
 * the caller wins.
 */
export const interceptors = (): WorkflowInterceptors => {
  let carried: Payload | undefined;
  const forward = <T extends { headers: Record<string, Payload> }>(input: T): T =>
    carried && !input.headers[TRACE_CONTEXT_HEADER]
      ? { ...input, headers: { ...input.headers, [TRACE_CONTEXT_HEADER]: carried } }
      : input;

  return {
    inbound: [
      {
        execute(input, next) {
          carried = input.headers[TRACE_CONTEXT_HEADER];
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
