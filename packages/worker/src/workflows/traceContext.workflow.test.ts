/**
 * End-to-end trace propagation through a real Temporal server, with the real
 * OpenTelemetry API and W3C propagator: the client interceptor stamps the
 * starter's context on the workflow, the workflow interceptor forwards it to an
 * activity and a child workflow's activity, and the activity interceptor parents
 * each activity span on it. Only the activity body is fake.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRACE_CONTEXT_HEADER as CLIENT_HEADER,
  TRACE_SIGNAL_HEADER as CLIENT_SIGNAL_HEADER,
  traceContextClientInterceptor,
} from '@auto-swe/shared/lib/temporalTracing';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { activitySpanInterceptor } from '../lib/activitySpans.js';
import { createWorkflowSpanSinks } from '../lib/workflowSpanSink.js';
import {
  TRACE_CONTEXT_HEADER as WORKFLOW_HEADER,
  TRACE_SIGNAL_HEADER as WORKFLOW_SIGNAL_HEADER,
} from './traceContextInterceptor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASK_QUEUE = 'trace-context-test';
const workflowsPath = path.resolve(__dirname, './testing/traceContextWorkflows.ts');
const interceptorPath = path.resolve(__dirname, './traceContextInterceptor.ts');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
// Registers the W3C propagator and the AsyncLocalStorage context manager, as the SDK does.
provider.register();

let env: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let client: Client;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  } catch (e) {
    if (/Failed to start ephemeral server|Forbidden|ECONNREFUSED/.test(String(e))) {
      return;
    }
    throw e;
  }
  client = new Client({
    connection: env.connection,
    interceptors: { workflow: [traceContextClientInterceptor()] },
  });
  worker = await Worker.create({
    activities: {
      hold: () => new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      probe: async () => {},
    },
    connection: env.nativeConnection,
    interceptors: { activity: [activitySpanInterceptor], workflowModules: [interceptorPath] },
    sinks: createWorkflowSpanSinks({
      processor: new SimpleSpanProcessor(exporter),
      resource: resourceFromAttributes({}),
    }),
    taskQueue: TASK_QUEUE,
    workflowsPath,
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  exporter.reset();
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
  await provider.shutdown();
}, 60_000);

const activitySpans = () => exporter.getFinishedSpans().filter((s) => s.name === 'activity.probe');
const workflowSpans = () =>
  exporter.getFinishedSpans().filter((s) => s.name.startsWith('workflow.'));

describe('trace context propagation through a workflow', () => {
  it('uses one header name on both sides of the isolate', () => {
    expect(WORKFLOW_HEADER).toBe(CLIENT_HEADER);
    expect(WORKFLOW_SIGNAL_HEADER).toBe(CLIENT_SIGNAL_HEADER);
  });

  it("hangs every activity off its run's workflow span, which hangs off the starter's span", async () => {
    const request = await trace
      .getTracer('test')
      .startActiveSpan('POST /api/v1/x', async (span) => {
        await client.workflow.execute('TraceParentWorkflow', {
          taskQueue: TASK_QUEUE,
          workflowId: 'trace-parent-1',
        });
        span.end();
        return span.spanContext();
      });

    // Exactly one span per run, exported once: the parent and its child.
    const wfSpans = workflowSpans();
    expect(wfSpans.map((s) => s.name).sort()).toEqual([
      'workflow.TraceChildWorkflow',
      'workflow.TraceParentWorkflow',
    ]);
    const parentWf = wfSpans.find((s) => s.name === 'workflow.TraceParentWorkflow');
    const childWf = wfSpans.find((s) => s.name === 'workflow.TraceChildWorkflow');
    expect(parentWf?.spanContext().traceId).toBe(request.traceId);
    expect(parentWf?.parentSpanContext?.spanId).toBe(request.spanId);
    expect(parentWf?.attributes['temporal.workflow_id']).toBe('trace-parent-1');
    expect(parentWf?.attributes['temporal.run_id']).toEqual(expect.any(String));
    expect(parentWf?.status.code).not.toBe(SpanStatusCode.ERROR);
    // The child's workflow span is a child of the parent's, in the same trace.
    expect(childWf?.spanContext().traceId).toBe(request.traceId);
    expect(childWf?.parentSpanContext?.spanId).toBe(parentWf?.spanContext().spanId);

    const spans = activitySpans();
    expect(spans).toHaveLength(2);
    const byWorkflow = (id: string) =>
      spans.find((s) => s.attributes['temporal.workflow_id'] === id);
    const fromParent = byWorkflow('trace-parent-1');
    const fromChild = byWorkflow('trace-parent-1-child');
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(request.traceId);
    }
    expect(fromParent?.parentSpanContext?.spanId).toBe(parentWf?.spanContext().spanId);
    expect(fromChild?.parentSpanContext?.spanId).toBe(childWf?.spanContext().spanId);
    // The workflow span covers its activity.
    const hr = (t: [number, number]) => t[0] * 1e9 + t[1];
    expect(hr(parentWf?.startTime as [number, number])).toBeLessThanOrEqual(
      hr(fromParent?.startTime as [number, number])
    );
  }, 60_000);

  it('puts every activity of a run started outside any span in one derived trace', async () => {
    await client.workflow.execute('TraceParentWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-parent-2',
    });

    const spans = activitySpans();
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    expect(spans[0]?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    // The workflow span is the root of the derived trace, and the activities hang off it.
    const traceId = spans[0]?.spanContext().traceId as string;
    const root = workflowSpans().find((w) => w.name === 'workflow.TraceParentWorkflow');
    expect(root?.spanContext().traceId).toBe(traceId);
    expect(root?.parentSpanContext).toBeUndefined();
    const parentActivity = spans.find(
      (sp) => sp.attributes['temporal.workflow_id'] === 'trace-parent-2'
    );
    expect(parentActivity?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);

    // A different run derives a different trace.
    exporter.reset();
    await client.workflow.execute('TraceParentWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-parent-2b',
    });
    expect(activitySpans()[0]?.spanContext().traceId).not.toBe(spans[0]?.spanContext().traceId);
  }, 60_000);

  it('links activities scheduled after a signal to the signal sender, without re-parenting them', async () => {
    const handle = await client.workflow.start('TraceSignalWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-signal-1',
    });
    const approval = await trace
      .getTracer('test')
      .startActiveSpan('POST /approve', async (span) => {
        await handle.signal('poke');
        span.end();
        return span.spanContext();
      });
    await handle.result();

    const [before, after] = activitySpans().sort(
      (a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]
    );
    expect(before?.links).toHaveLength(0);
    expect(after?.links).toHaveLength(1);
    expect(after?.links[0]?.context.spanId).toBe(approval.spanId);
    expect(after?.links[0]?.context.traceId).toBe(approval.traceId);
    expect(after?.spanContext().traceId).not.toBe(approval.traceId);

    // The signal header and the derived carrier are headers too: the history
    // replays with the interceptor and without it.
    const history = await handle.fetchHistory();
    for (const workerOptions of [
      { workflowsPath },
      {
        interceptors: { workflowModules: [interceptorPath] },
        sinks: createWorkflowSpanSinks(undefined),
        workflowsPath,
      },
    ]) {
      await expect(
        Worker.runReplayHistory(workerOptions, history, 'trace-signal-1')
      ).resolves.toBeUndefined();
    }
  }, 60_000);

  it("keeps a signal's link on the activities of a child workflow started after it", async () => {
    const handle = await client.workflow.start('TraceSignalParentWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-signal-2',
    });
    const approval = await trace
      .getTracer('test')
      .startActiveSpan('POST /approve', async (span) => {
        await handle.signal('poke');
        span.end();
        return span.spanContext();
      });
    await handle.result();

    const [child] = activitySpans();
    expect(child?.links).toHaveLength(1);
    expect(child?.links[0]?.context.spanId).toBe(approval.spanId);
  }, 60_000);

  it('exports the workflow span once, with an error status, when the run fails', async () => {
    await expect(
      client.workflow.execute('TraceFailingWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId: 'trace-fail-1',
      })
    ).rejects.toThrow();

    const [span] = workflowSpans();
    expect(workflowSpans()).toHaveLength(1);
    expect(span?.name).toBe('workflow.TraceFailingWorkflow');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('boom');
    expect(span?.attributes['temporal.outcome']).toBe('failed');
    expect(activitySpans()[0]?.parentSpanContext?.spanId).toBe(span?.spanContext().spanId);
  }, 60_000);

  it('gives each run of a continue-as-new chain its own span, parented on the previous run', async () => {
    await client.workflow.execute('TraceContinueWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-can-1',
    });

    const spans = workflowSpans();
    expect(spans).toHaveLength(2);
    const first = spans.find((s) => s.attributes['temporal.outcome'] === 'continued-as-new');
    const second = spans.find((s) => s.attributes['temporal.outcome'] === 'completed');
    expect(first?.parentSpanContext).toBeUndefined();
    expect(second?.spanContext().traceId).toBe(first?.spanContext().traceId);
    expect(second?.parentSpanContext?.spanId).toBe(first?.spanContext().spanId);
    expect(second?.spanContext().spanId).not.toBe(first?.spanContext().spanId);
  }, 60_000);

  it('exports a cancelled run, cancelled while awaiting an activity, as cancelled and not as an error', async () => {
    const handle = await client.workflow.start('TraceCancelWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-cancel-1',
    });
    for (let i = 0; i < 50; i++) {
      if ((await handle.describe()).raw.pendingActivities?.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();

    const [span] = workflowSpans();
    expect(workflowSpans()).toHaveLength(1);
    expect(span?.name).toBe('workflow.TraceCancelWorkflow');
    expect(span?.attributes['temporal.outcome']).toBe('cancelled');
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  }, 60_000);

  it('exports nothing for a plain error, which fails the workflow task and is retried', async () => {
    const handle = await client.workflow.start('TracePlainErrorWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-plain-1',
    });
    await new Promise((r) => setTimeout(r, 2000));
    await handle.terminate('test over');
    expect(workflowSpans()).toHaveLength(0);
  }, 60_000);

  it('stamps signals only when the client propagates them', () => {
    expect(traceContextClientInterceptor().signal).toBeTypeOf('function');
    expect(traceContextClientInterceptor().startUpdate).toBeTypeOf('function');
    const quiet = traceContextClientInterceptor({ propagateSignals: false });
    expect(quiet.signal).toBeUndefined();
    expect(quiet.startUpdate).toBeUndefined();
    expect(quiet.startWithDetails).toBeTypeOf('function');
    expect(quiet.signalWithStart).toBeTypeOf('function');
  });

  it('replays a history that carries the header with or without the interceptor', async () => {
    await trace.getTracer('test').startActiveSpan('request', async (span) => {
      await client.workflow.execute('TraceParentWorkflow', {
        taskQueue: TASK_QUEUE,
        workflowId: 'trace-parent-3',
      });
      span.end();
    });
    const history = await client.workflow.getHandle('trace-parent-3').fetchHistory();

    // Headers are not part of the commands Temporal compares on replay, so a
    // worker deployed without the interceptor (or with it, over a history
    // recorded without it) takes the same path.
    // The workflow id is passed because the child's id derives from it.
    await expect(
      Worker.runReplayHistory({ workflowsPath }, history, 'trace-parent-3')
    ).resolves.toBeUndefined();
    await expect(
      Worker.runReplayHistory(
        {
          interceptors: { workflowModules: [interceptorPath] },
          sinks: createWorkflowSpanSinks(undefined),
          workflowsPath,
        },
        history,
        'trace-parent-3'
      )
    ).resolves.toBeUndefined();
  }, 120_000);
});
