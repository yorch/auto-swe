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
  traceContextClientInterceptor,
} from '@auto-swe/shared/lib/temporalTracing';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it, type TestContext } from 'vitest';
import { activitySpanInterceptor } from '../lib/activitySpans.js';
import { TRACE_CONTEXT_HEADER as WORKFLOW_HEADER } from './traceContextInterceptor.js';

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
    activities: { probe: async () => {} },
    connection: env.nativeConnection,
    interceptors: { activity: [activitySpanInterceptor], workflowModules: [interceptorPath] },
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

describe('trace context propagation through a workflow', () => {
  it('uses one header name on both sides of the isolate', () => {
    expect(WORKFLOW_HEADER).toBe(CLIENT_HEADER);
  });

  it("parents every activity of the run, a child workflow's included, on the starter's span", async () => {
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

    const spans = activitySpans();
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      expect(s.spanContext().traceId).toBe(request.traceId);
      expect(s.parentSpanContext?.spanId).toBe(request.spanId);
    }
  }, 60_000);

  it('gives each activity its own trace when the workflow was started outside any span', async () => {
    await client.workflow.execute('TraceParentWorkflow', {
      taskQueue: TASK_QUEUE,
      workflowId: 'trace-parent-2',
    });

    const spans = activitySpans();
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.parentSpanContext === undefined)).toBe(true);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(2);
  }, 60_000);

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
        { interceptors: { workflowModules: [interceptorPath] }, workflowsPath },
        history,
        'trace-parent-3'
      )
    ).resolves.toBeUndefined();
  }, 120_000);
});
