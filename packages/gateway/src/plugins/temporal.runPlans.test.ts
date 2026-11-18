import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async (..._args: unknown[]) => ({}));
const execute = vi.fn(async (..._args: unknown[]) => ({}));
const handle = {
  describe: vi.fn(),
  fetchHistory: vi.fn(),
  result: vi.fn(),
};
const getHandle = vi.fn((_id: string) => handle);

vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = { execute, getHandle, start };
  },
  Connection: { connect: vi.fn(async () => ({})) },
  defaultPayloadConverter: { fromPayload: (p: { value: unknown }) => p.value },
  ScheduleClient: class {},
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdConflictPolicy: {},
  WorkflowIdReusePolicy: { REJECT_DUPLICATE: 'REJECT_DUPLICATE' },
  WorkflowNotFoundError: class extends Error {},
}));

import temporalPlugin from './temporal.js';

async function build() {
  const app = Fastify();
  await app.register(temporalPlugin);
  await app.ready();
  await app.temporalConnection.whenConnected();
  return app;
}

const INPUT = {
  intent: 'do the thing',
  launchableAgentKeys: ['contentWriter'],
  mode: 'delivering' as const,
  teamId: 'team-1',
};
const MEMO = {
  intentHash: 'h',
  mode: 'delivering' as const,
  ownerUserId: 'u1',
  repoId: 'r1',
  teamId: 'team-1',
};

beforeEach(() => {
  start.mockReset();
  execute.mockReset();
  handle.describe.mockReset();
  handle.fetchHistory.mockReset();
  handle.result.mockReset();
});

describe('startRunPlanGeneration', () => {
  it('starts RunPlanGenerationWorkflow under the id with the memo, never reusing a closed id', async () => {
    const app = await build();
    const out = await app.temporal.startRunPlanGeneration('runplan-a-b', INPUT, MEMO);
    expect(out).toEqual({ started: true });
    expect(start).toHaveBeenCalledWith('RunPlanGenerationWorkflow', {
      args: [INPUT],
      memo: MEMO,
      taskQueue: 'engineering-workflow',
      workflowExecutionTimeout: '12 minutes',
      workflowId: 'runplan-a-b',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
  });

  it('reports a taken id as not started and surfaces any other failure', async () => {
    const app = await build();
    start.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'WorkflowExecutionAlreadyStartedError' })
    );
    expect(await app.temporal.startRunPlanGeneration('runplan-a-b', INPUT, MEMO)).toEqual({
      started: false,
    });
    start.mockRejectedValueOnce(new Error('down'));
    await expect(app.temporal.startRunPlanGeneration('runplan-a-b', INPUT, MEMO)).rejects.toThrow(
      'down'
    );
  });
});

describe('getRunPlanJob', () => {
  const desc = (name: string, extra: Record<string, unknown> = {}) => ({
    memo: MEMO,
    status: { name },
    ...extra,
  });

  it('says not_found only for a missing execution, and rethrows an unreachable server', async () => {
    const app = await build();
    handle.describe.mockRejectedValueOnce(
      Object.assign(new Error('x'), { name: 'WorkflowNotFoundError' })
    );
    expect(await app.temporal.getRunPlanJob('runplan-a-b')).toEqual({ status: 'not_found' });
    handle.describe.mockRejectedValueOnce(new Error('unreachable'));
    await expect(app.temporal.getRunPlanJob('runplan-a-b')).rejects.toThrow('unreachable');
  });

  it('returns the memo of a running job without waiting for it', async () => {
    const app = await build();
    handle.describe.mockResolvedValueOnce(desc('RUNNING'));
    expect(await app.temporal.getRunPlanJob('runplan-a-b')).toEqual({
      memo: MEMO,
      status: 'running',
    });
    expect(handle.result).not.toHaveBeenCalled();
  });

  it('returns the result and the recorded input of a completed job', async () => {
    const app = await build();
    const closeTime = new Date();
    handle.describe.mockResolvedValueOnce(desc('COMPLETED', { closeTime }));
    handle.result.mockResolvedValueOnce({ model: 'm' });
    handle.fetchHistory.mockResolvedValueOnce({
      events: [
        { workflowExecutionStartedEventAttributes: { input: { payloads: [{ value: INPUT }] } } },
      ],
    });
    expect(await app.temporal.getRunPlanJob('runplan-a-b')).toEqual({
      closedAt: closeTime,
      input: INPUT,
      memo: MEMO,
      result: { model: 'm' },
      status: 'done',
    });
  });

  it('reports a completed job whose result or input cannot be read as unavailable', async () => {
    const app = await build();
    handle.describe.mockResolvedValueOnce(desc('COMPLETED'));
    handle.result.mockResolvedValueOnce({ model: 'm' });
    handle.fetchHistory.mockResolvedValueOnce({ events: [] });
    expect(await app.temporal.getRunPlanJob('runplan-a-b')).toMatchObject({
      code: 'GENERATION_UNAVAILABLE',
      status: 'failed',
    });
  });

  it('reads the structured failure type anywhere in the cause chain', async () => {
    const app = await build();
    handle.describe.mockResolvedValueOnce(desc('FAILED'));
    handle.result.mockRejectedValueOnce(
      Object.assign(new Error('workflow failed'), {
        cause: Object.assign(new Error('activity failed'), {
          cause: Object.assign(new Error('with the user text inside'), {
            type: 'GENERATION_FAILED',
          }),
        }),
      })
    );
    const state = await app.temporal.getRunPlanJob('runplan-a-b');
    expect(state).toEqual({ code: 'GENERATION_FAILED', memo: MEMO, status: 'failed' });
    // Only a known type is trusted; anything else, and a timeout, is "unavailable".
    handle.describe.mockResolvedValueOnce(desc('TIMED_OUT'));
    handle.result.mockRejectedValueOnce(Object.assign(new Error('t'), { type: 'SOMETHING_ELSE' }));
    expect(await app.temporal.getRunPlanJob('runplan-a-b')).toMatchObject({
      code: 'GENERATION_UNAVAILABLE',
    });
  });
});

describe('routeRunPlan', () => {
  it('executes RunPlanRouteWorkflow and awaits its result', async () => {
    const app = await build();
    execute.mockResolvedValueOnce({ matches: [], noneFit: true });
    const input = { candidates: [], intent: 'x', maxResults: 5, teamId: 'team-1' };
    expect(await app.temporal.routeRunPlan('runplan-route-a-b', input)).toEqual({
      matches: [],
      noneFit: true,
    });
    expect(execute).toHaveBeenCalledWith('RunPlanRouteWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowExecutionTimeout: '4 minutes',
      workflowId: 'runplan-route-a-b',
    });
  });
});
