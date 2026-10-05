import { type HrTime, SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { InjectedSinks } from '@temporalio/worker';
import type { WorkflowSpanRecord, WorkflowSpanSinks } from '../workflows/workflowSpan.js';

/** Where workflow spans go: the span processor the worker's exporter sits behind, and its resource. */
export interface WorkflowSpanTarget {
  processor: SpanProcessor;
  resource: Resource;
}

function toHrTime(ms: number): HrTime {
  const seconds = Math.floor(ms / 1000);
  return [seconds, Math.round((ms - seconds * 1000) * 1e6)];
}

/**
 * The finished span a run's record describes. OpenTelemetry's tracer API cannot
 * be told which span id to use — the id is the one the workflow interceptor
 * already stamped on every activity's carrier — so this builds the
 * {@link ReadableSpan} itself and hands it to a span processor, exactly what a
 * tracer does when a span ends. `ReadableSpan` is the SDK's public export
 * contract, so no private state is touched.
 */
export function workflowReadableSpan(
  record: WorkflowSpanRecord,
  info: { workflowId: string; runId: string; workflowType: string },
  resource: Resource
): ReadableSpan {
  const start = toHrTime(record.startTimeMs);
  const end = toHrTime(Math.max(record.endTimeMs, record.startTimeMs));
  const durationMs = Math.max(record.endTimeMs - record.startTimeMs, 0);
  const failed = record.outcome === 'failed';
  const parentFlags = Number.parseInt(record.flags, 16);
  const flags = Number.isNaN(parentFlags) ? TraceFlags.SAMPLED : parentFlags;
  return {
    attributes: {
      'temporal.outcome': record.outcome,
      'temporal.run_id': info.runId,
      'temporal.workflow_id': info.workflowId,
      'temporal.workflow_type': info.workflowType,
    },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    duration: toHrTime(durationMs),
    ended: true,
    endTime: end,
    events: [],
    instrumentationScope: { name: 'auto-swe-worker' },
    kind: SpanKind.INTERNAL,
    links: [],
    name: `workflow.${info.workflowType}`,
    ...(record.parentSpanId
      ? {
          parentSpanContext: {
            isRemote: true,
            spanId: record.parentSpanId,
            traceFlags: flags,
            traceId: record.traceId,
          },
        }
      : {}),
    resource,
    spanContext: () => ({
      spanId: record.spanId,
      traceFlags: flags,
      traceId: record.traceId,
    }),
    startTime: start,
    status: failed
      ? { code: SpanStatusCode.ERROR, message: record.errorMessage }
      : { code: SpanStatusCode.UNSET },
  };
}

/**
 * The worker half of the workflow span: receives the record the workflow
 * interceptor emits when a run's workflow code ends and exports it. With no
 * target (telemetry disabled) the sink is a no-op. An unsampled trace is dropped
 * by the processor, so the workflow span follows the same sampling decision as
 * the activities beneath it.
 *
 * `callDuringReplay: false`: a replay re-executes the run's history without
 * re-emitting its span, so a worker restart does not export a run twice.
 */
export function createWorkflowSpanSinks(
  target: WorkflowSpanTarget | undefined
): InjectedSinks<WorkflowSpanSinks> {
  return {
    workflowSpans: {
      exportSpan: {
        callDuringReplay: false,
        fn: (info, record) => {
          if (!target) {
            return;
          }
          target.processor.onEnd(workflowReadableSpan(record, info, target.resource));
        },
      },
    },
  };
}
