import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { WorkflowInfo } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';
import type { WorkflowSpanRecord } from '../workflows/workflowSpan.js';
import { createWorkflowSpanSinks } from './workflowSpanSink.js';

const info = {
  runId: 'run-1',
  workflowId: 'wf-1',
  workflowType: 'RunnableWorkflow',
} as WorkflowInfo;

const record: WorkflowSpanRecord = {
  endTimeMs: 1_700_000_005_500,
  flags: '01',
  outcome: 'completed',
  parentSpanId: '00f067aa0ba902b7',
  spanId: '1111222233334444',
  startTimeMs: 1_700_000_000_250,
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
};

function setup() {
  const exporter = new InMemorySpanExporter();
  const resource = resourceFromAttributes({ 'service.name': 'test' });
  const { exportSpan } = createWorkflowSpanSinks({
    processor: new SimpleSpanProcessor(exporter),
    resource,
  }).workflowSpans;
  return { exporter, exportSpan, resource };
}

describe('workflow span sink', () => {
  it('is not called during replay', () => {
    expect(setup().exportSpan.callDuringReplay).toBe(false);
  });

  it('exports a span with exactly the ids, parent, times and attributes it was given', async () => {
    const { exportSpan, exporter, resource } = setup();
    await exportSpan.fn(info, record);

    const [span] = exporter.getFinishedSpans();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(span?.name).toBe('workflow.RunnableWorkflow');
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.spanContext()).toMatchObject({ spanId: record.spanId, traceId: record.traceId });
    expect(span?.parentSpanContext?.spanId).toBe(record.parentSpanId);
    expect(span?.parentSpanContext?.traceId).toBe(record.traceId);
    expect(span?.startTime).toEqual([1_700_000_000, 250_000_000]);
    expect(span?.endTime).toEqual([1_700_000_005, 500_000_000]);
    expect(span?.duration).toEqual([5, 250_000_000]);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes).toMatchObject({
      'temporal.outcome': 'completed',
      'temporal.run_id': 'run-1',
      'temporal.workflow_id': 'wf-1',
      'temporal.workflow_type': 'RunnableWorkflow',
    });
    expect(span?.resource).toBe(resource);
  });

  it('marks a failed run as an error and a parentless run as a root', async () => {
    const { exportSpan, exporter } = setup();
    const { parentSpanId: _omit, ...rootless } = record;
    await exportSpan.fn(info, { ...rootless, errorMessage: 'boom', outcome: 'failed' });

    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(span?.parentSpanContext).toBeUndefined();
  });

  it('drops a span whose trace is not sampled', async () => {
    const { exportSpan, exporter } = setup();
    await exportSpan.fn(info, { ...record, flags: '00' });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('exports through a batch processor once it is flushed', async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new BatchSpanProcessor(exporter);
    const { exportSpan } = createWorkflowSpanSinks({
      processor,
      resource: resourceFromAttributes({}),
    }).workflowSpans;
    await exportSpan.fn(info, record);
    await processor.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    await processor.shutdown();
  });

  it('is a no-op when telemetry is disabled', async () => {
    const { exportSpan } = createWorkflowSpanSinks(undefined).workflowSpans;
    await expect(Promise.resolve(exportSpan.fn(info, record))).resolves.toBeUndefined();
  });
});
