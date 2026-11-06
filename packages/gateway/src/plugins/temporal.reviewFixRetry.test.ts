import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn();
vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = { start };
  },
  Connection: { connect: vi.fn(async () => ({ close: vi.fn(async () => {}) })) },
  ScheduleClient: class {},
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdConflictPolicy: {},
  WorkflowIdReusePolicy: { ALLOW_DUPLICATE_FAILED_ONLY: 'ALLOW_DUPLICATE_FAILED_ONLY' },
}));

import temporalPlugin from './temporal.js';

const apps: ReturnType<typeof Fastify>[] = [];
async function build() {
  const app = Fastify();
  apps.push(app);
  await app.register(temporalPlugin);
  await app.ready();
  await app.temporalConnection.whenConnected();
  return app;
}

beforeEach(() => start.mockReset());
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('startReviewFixRetry', () => {
  const input = { attemptId: 'attempt-2', runId: 'review-run' };
  it('allows failed orchestrations to restart without replaying completed attempts', async () => {
    const app = await build();
    await app.temporal.startReviewFixRetry('retry-workflow', input);
    expect(start).toHaveBeenCalledWith('reviewFixRetryWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowId: 'retry-workflow',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
    });
  });
  it('coalesces an already-started attempt', async () => {
    const app = await build();
    start.mockRejectedValueOnce(
      Object.assign(new Error('started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      })
    );
    await expect(
      app.temporal.startReviewFixRetry('retry-workflow', input)
    ).resolves.toBeUndefined();
  });
  it('preserves scheduling failures for the caller', async () => {
    const app = await build();
    start.mockRejectedValueOnce(new Error('unreachable'));
    await expect(app.temporal.startReviewFixRetry('retry-workflow', input)).rejects.toThrow(
      'unreachable'
    );
  });
});
