import { beforeEach, describe, expect, it, vi } from 'vitest';

const { span, started, recordDuration } = vi.hoisted(() => ({
  recordDuration: vi.fn(),
  span: { end: vi.fn(), recordException: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn() },
  started: [] as Array<{
    name: string;
    attributes: Record<string, unknown>;
    links: unknown[];
    parent: unknown;
  }>,
}));

vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: { ERROR: 2 },
  trace: {
    getTracer: () => ({
      startActiveSpan: (
        name: string,
        opts: { attributes: Record<string, unknown>; links: unknown[] },
        parent: unknown,
        fn: (s: typeof span) => unknown
      ) => {
        started.push({ attributes: opts.attributes, links: opts.links, name, parent });
        return fn(span);
      },
    }),
  },
}));

vi.mock('./metrics.js', () => ({ recordActivityDuration: recordDuration }));

// Real propagation is covered end to end in workflows/traceContext.workflow.test.ts.
vi.mock('@auto-swe/shared/lib/temporalTracing', () => ({
  signalLinkFromHeaders: (headers: Record<string, unknown>) =>
    headers.signal ? { context: { spanId: 's', traceId: 't' } } : undefined,
  traceContextFromHeaders: (headers: Record<string, unknown>) => ({ fromHeaders: headers }),
}));

import { CancelledFailure } from '@temporalio/activity';
import { activitySpanInterceptor } from './activitySpans.js';

const ctx = {
  info: {
    activityType: 'executeImplementation',
    attempt: 2,
    taskQueue: 'engineering-workflow',
    workflowExecution: { runId: 'r', workflowId: 'eng-acme-svc-JIRA-1' },
    workflowType: 'RunnableWorkflow',
  },
} as never;

const input = { args: [], headers: {} };

beforeEach(() => {
  vi.clearAllMocks();
  started.length = 0;
});

describe('activitySpanInterceptor', () => {
  it('links the span to the signal that preceded the activity', async () => {
    await activitySpanInterceptor(ctx).inbound?.execute?.(
      { args: [], headers: { signal: {} } } as never,
      async () => 'x'
    );

    expect(started[0]?.links).toEqual([{ context: { spanId: 's', traceId: 't' } }]);
  });

  it('runs the activity inside a span named for it, tagged with its workflow', async () => {
    const next = vi.fn(async () => 'result');

    const out = await activitySpanInterceptor(ctx).inbound?.execute?.(input, next);

    expect(out).toBe('result');
    expect(next).toHaveBeenCalledWith(input);
    expect(started).toEqual([
      {
        attributes: expect.objectContaining({
          'temporal.attempt': 2,
          'temporal.workflow_id': 'eng-acme-svc-JIRA-1',
        }),
        links: [],
        name: 'activity.executeImplementation',
        parent: { fromHeaders: {} },
      },
    ]);
    expect(span.end).toHaveBeenCalled();
    expect(recordDuration).toHaveBeenCalledWith(
      'executeImplementation',
      'success',
      expect.any(Number)
    );
  });

  it('marks the span failed, still ends it, and rethrows', async () => {
    const boom = new Error('docker went away');

    await expect(
      activitySpanInterceptor(ctx).inbound?.execute?.(input, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(span.recordException).toHaveBeenCalledWith(boom);
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'docker went away' });
    expect(span.end).toHaveBeenCalled();
    expect(recordDuration).toHaveBeenCalledWith(
      'executeImplementation',
      'failure',
      expect.any(Number)
    );
  });

  it('records a cancelled attempt as cancelled, not as a failure', async () => {
    const cancelled = new CancelledFailure('CANCELLED');

    await expect(
      activitySpanInterceptor(ctx).inbound?.execute?.(input, async () => {
        throw cancelled;
      })
    ).rejects.toBe(cancelled);

    expect(span.setStatus).not.toHaveBeenCalled();
    expect(span.setAttribute).toHaveBeenCalledWith('temporal.cancelled', true);
    expect(recordDuration).toHaveBeenCalledWith(
      'executeImplementation',
      'cancelled',
      expect.any(Number)
    );
  });
});
