import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context } from '@temporalio/activity';
import type { ActivityInterceptors } from '@temporalio/worker';
import { recordActivityDuration } from './metrics.js';

const tracer = trace.getTracer('auto-swe-worker');

/**
 * Wraps every activity attempt in an `activity.<type>` span and times it.
 *
 * Without it, the `llm.*` spans an activity opens are roots with nothing tying
 * them to one another or to the workflow, and AgentTrace rows persisted outside
 * an LLM span carry no trace ID at all. Under it, everything an attempt does
 * shares one trace, and the workflow ID on the span finds it in Tempo.
 *
 * Activity-side only, on purpose. Propagating context from the workflow would
 * take a workflow interceptor inside the V8 isolate, and the official package
 * for that pins the 1.x OpenTelemetry SDK beside this repo's 2.x one.
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
          },
          async (span) => {
            const start = performance.now();
            let outcome: 'success' | 'failure' = 'success';
            try {
              return await next(input);
            } catch (err) {
              outcome = 'failure';
              span.recordException(err as Error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
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
