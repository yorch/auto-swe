import { reconcileAgentRunSlots } from '@auto-swe/shared/lib/agentRunAdmission';
import { liveInFlightExecution } from '@auto-swe/shared/lib/requestInFlight';
import Fastify, { type FastifyError } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  healthBody,
  isTemporalUnavailable,
  isTerminalSignalError,
  replyIfTemporalUnavailable,
  TemporalUnavailableError,
} from '../lib/temporalErrors.js';

const signal = vi.fn(async () => undefined);
const cancel = vi.fn(async () => undefined);
const describeWorkflow = vi.fn(async () => ({ status: { name: 'RUNNING' } }));
const connect = vi.fn();
const close = vi.fn(async () => undefined);

vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = {
      getHandle: () => ({ cancel, describe: describeWorkflow, signal }),
    };
  },
  Connection: { connect: (...args: unknown[]) => connect(...args) },
  ScheduleClient: class {
    getHandle() {
      return {};
    }
  },
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdReusePolicy: {},
}));

import temporalPlugin from './temporal.js';

/** Mirrors the wiring in index.ts: the same helpers, on a tiny app. */
async function build() {
  const app = Fastify();
  await app.register(temporalPlugin, { connectBackoffMs: { initial: 5, max: 20 } });
  app.setErrorHandler(async (error: FastifyError, _req, reply) => {
    const unavailable = replyIfTemporalUnavailable(error, reply);
    if (unavailable) {
      return unavailable;
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal' } });
  });
  app.get('/health', async () => healthBody(app.temporalConnection));
  app.post('/cancel', async () => {
    await app.temporal.cancelWorkflow('wf-1');
    return { data: { cancelled: true } };
  });
  await app.ready();
  return app;
}

const openApps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((a) => a.close()));
  vi.clearAllMocks();
  connect.mockReset();
});

describe('gateway without Temporal', () => {
  it('becomes ready with an unreachable Temporal, reports it down, and answers 503 TEMPORAL_UNAVAILABLE', async () => {
    // A connect that never settles is the worst case: the plugin must not wait on it.
    connect.mockImplementation(() => new Promise(() => undefined));
    const app = await build();
    openApps.push(app);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', temporal: 'connecting' });

    const res = await app.inject({ method: 'POST', url: '/cancel' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(res.json().error.message).toMatch(/not connected/);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('retries with backoff, then serves requests and reports up once connected', async () => {
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ close });
    const app = await build();
    openApps.push(app);
    expect((await app.inject({ method: 'POST', url: '/cancel' })).statusCode).toBe(503);

    await app.temporalConnection.whenConnected();

    expect(connect).toHaveBeenCalledTimes(3);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
      temporal: 'connected',
    });
    const res = await app.inject({ method: 'POST', url: '/cancel' });
    expect(res.statusCode).toBe(200);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('closes a connection that succeeds after the app closed, and leaves no retry timer', async () => {
    let succeed: (c: { close: typeof close }) => void = () => undefined;
    connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          succeed = resolve as typeof succeed;
        })
    );
    const app = await build();
    await app.close();
    // The in-flight connect completes only now, after close.
    succeed({ close });
    await new Promise((r) => setTimeout(r, 30));
    expect(close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(app.temporalConnection.state()).toBe('connecting');
  });

  it('stops retrying when the app closes', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const app = await build();
    await new Promise((r) => setTimeout(r, 30));
    await app.close();
    const calls = connect.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(connect.mock.calls.length).toBe(calls);
  });

  it('getWorkflowAuthorJobStatus: only a missing execution is "not found"; other failures are unknown', async () => {
    connect.mockResolvedValue({ close });
    const app = await build();
    openApps.push(app);
    await app.temporalConnection.whenConnected();
    const notFound = new Error('nope');
    notFound.name = 'WorkflowNotFoundError';
    describeWorkflow.mockRejectedValueOnce(notFound);
    await expect(app.temporal.getWorkflowAuthorJobStatus('job-1')).resolves.toMatchObject({
      code: 'NOT_FOUND',
      status: 'failed',
    });
    describeWorkflow.mockRejectedValueOnce(new Error('deadline exceeded'));
    await expect(app.temporal.getWorkflowAuthorJobStatus('job-1')).rejects.toThrow(
      'deadline exceeded'
    );
  });

  it('answers a route-level 503 with Retry-After', async () => {
    connect.mockImplementation(() => new Promise(() => undefined));
    const app = await build();
    openApps.push(app);
    const res = await app.inject({ method: 'POST', url: '/cancel' });
    expect(res.headers['retry-after']).toBe('5');
  });

  it('is never read as "workflow gone": a signal failure is retryable, lookups reject', async () => {
    connect.mockImplementation(() => new Promise(() => undefined));
    const app = await build();
    openApps.push(app);
    const err = await app.temporal.isWorkflowGone('wf-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemporalUnavailableError);
    expect(isTemporalUnavailable(err)).toBe(true);
    expect(isTerminalSignalError(err)).toBe(false);
    await expect(app.temporal.workflowSettledStatus('wf-1')).rejects.toBeInstanceOf(
      TemporalUnavailableError
    );
    await expect(app.temporal.signalWorkflow('wf-1', 's')).rejects.toBeInstanceOf(
      TemporalUnavailableError
    );
    expect(describeWorkflow).not.toHaveBeenCalled();
  });

  it('request in-flight confirmation treats a disconnected Temporal as unconfirmed, not finished', async () => {
    connect.mockImplementation(() => new Promise(() => undefined));
    const app = await build();
    openApps.push(app);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      activeWorkflow: {
        findMany: async () => [
          { temporalWorkflowId: 'eng-1', updatedAt: new Date(Date.now() - 3_600_000) },
        ],
        updateMany,
      },
    };
    const settled = app.temporal.workflowSettledStatus;
    const blocking = await liveInFlightExecution(db as never, 'wr-1', { settled });
    expect(blocking).toEqual({ temporalWorkflowId: 'eng-1', unconfirmed: true });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('agent-run admission keeps the concurrency slot when Temporal is not connected', async () => {
    connect.mockImplementation(() => new Promise(() => undefined));
    const app = await build();
    openApps.push(app);
    const slot = {
      launchedAt: new Date(Date.now() - 3_600_000),
      teamId: 't1',
      workflowId: 'agent-1',
    };
    const close = vi.fn(async () => undefined);
    const onUnreachable = vi.fn();
    const live = await reconcileAgentRunSlots([slot], {
      close,
      isRunning: async (id) => !(await app.temporal.isWorkflowGone(id)),
      onClosed: () => undefined,
      onUnreachable,
    });
    expect(live).toEqual([slot]);
    expect(close).not.toHaveBeenCalled();
    expect(onUnreachable).toHaveBeenCalledWith('agent-1', expect.any(TemporalUnavailableError));
  });
});
