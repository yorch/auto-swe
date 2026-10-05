import {
  signalLinkFromHeaders,
  traceContextFromHeaders,
} from '@auto-swe/shared/lib/temporalTracing';
import { type Link, SpanStatusCode, trace } from '@opentelemetry/api';
import { CancelledFailure, type Context } from '@temporalio/activity';
import type { ActivityInterceptors } from '@temporalio/worker';
import { recordActivityDuration } from './metrics.js';

const tracer = trace.getTracer('auto-swe-worker');

function signalLinks(headers: Parameters<typeof signalLinkFromHeaders>[0]): Link[] {
  const link = signalLinkFromHeaders(headers);
  return link ? [link] : [];
}

/**
 * A cancelled attempt (dashboard cancel, heartbeat timeout, reset) is not a
 * failure of the activity; counting it as one makes every user cancel read as
 * an outage on the failure-rate panel.
 */
function isCancellation(err: unknown): boolean {
  return err instanceof CancelledFailure || (err as Error | undefined)?.name === 'AbortError';
}

/**
 * Wraps every activity attempt in an `activity.<type>` span and times it.
 *
 * Without it, the `llm.*` spans an activity opens are roots with nothing tying
 * them to one another or to the workflow, and AgentTrace rows persisted outside
 * an LLM span carry no trace ID at all. Under it, everything an attempt does
 * shares one trace, and the workflow ID on the span finds it in Tempo.
 *
 * The span's parent is the run's workflow span, whose context the workflow
 * forwards as a header on every activity it schedules (see
 * `@auto-swe/shared/lib/temporalTracing` and `lib/workflowSpanSink.ts`). The
 * workflow span is itself a child of whoever started the workflow — a gateway
 * request, say — so every activity of a run shares the starter's trace. A
 * workflow started without a context (a schedule) gets a trace id derived from
 * its identity by the workflow interceptor, and its workflow span is the root.
 * Activities scheduled after a signal or update also carry a span link to that
 * signal's span.
 *
 * Not `@temporalio/interceptors-opentelemetry`: it pins the 1.x OpenTelemetry
 * SDK beside this repo's 2.x one, and runs OpenTelemetry inside the isolate.
 */
export function activitySpanInterceptor(ctx: Context): ActivityInterceptors {
  const { info } = ctx;
  return {
    inbound: {
      execute: (input, next) =>
        tracer.startActiveSpan(
          `activity.${info.activityType}`,
          {
            attributes: {
              'temporal.activity_type': info.activityType,
              'temporal.attempt': info.attempt,
              'temporal.task_queue': info.taskQueue,
              'temporal.workflow_id': info.workflowExecution?.workflowId ?? '',
              'temporal.workflow_type': info.workflowType ?? '',
            },
            links: signalLinks(input.headers),
          },
          traceContextFromHeaders(input.headers),
          async (span) => {
            const start = performance.now();
            let outcome: 'success' | 'failure' | 'cancelled' = 'success';
            try {
              return await next(input);
            } catch (err) {
              if (isCancellation(err)) {
                outcome = 'cancelled';
                span.setAttribute('temporal.cancelled', true);
              } else {
                outcome = 'failure';
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
              }
              throw err;
            } finally {
              span.end();
              recordActivityDuration(
                info.activityType,
                outcome,
                (performance.now() - start) / 1000
              );
            }
          }
        ),
    },
  };
}
