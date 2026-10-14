import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async () => ({}));

vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = { start };
  },
  Connection: { connect: vi.fn(async () => ({})) },
  ScheduleClient: class {},
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdConflictPolicy: { USE_EXISTING: 'USE_EXISTING' },
  WorkflowIdReusePolicy: {},
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

beforeEach(() => start.mockReset());

describe('startEvalScreenWorkflow', () => {
  it('joins a screen already running under the dataset id', async () => {
    start.mockResolvedValue({});
    const app = await build();
    await app.temporal.startEvalScreenWorkflow('eval-screen-d1', { datasetId: 'd1' });
    expect(start).toHaveBeenCalledWith('EvalScreenWorkflow', {
      args: [{ datasetId: 'd1' }],
      taskQueue: 'engineering-workflow',
      workflowId: 'eval-screen-d1',
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  });

  it('treats an already-started screen as joined', async () => {
    const app = await build();
    start.mockImplementationOnce(async () => {
      throw Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' });
    });
    await expect(
      app.temporal.startEvalScreenWorkflow('eval-screen-d1', { datasetId: 'd1' })
    ).resolves.toBeUndefined();
  });

  it('still surfaces any other start failure', async () => {
    const app = await build();
    start.mockImplementationOnce(async () => {
      throw new Error('unreachable');
    });
    await expect(
      app.temporal.startEvalScreenWorkflow('eval-screen-d1', { datasetId: 'd1' })
    ).rejects.toThrow('unreachable');
  });
});
