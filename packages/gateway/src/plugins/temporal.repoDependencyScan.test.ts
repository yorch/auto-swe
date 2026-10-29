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

// The gateway starts this workflow by NAME, so the name, the queue, the argument shape and the id
// are a contract with the worker (`RepoDependencyScanOneWorkflow`), and nothing else checks them.
describe('startRepoDependencyScan', () => {
  it('starts the one-repository scan by name, under a per-repository id that joins a running one', async () => {
    start.mockResolvedValue({});
    const app = await build();
    await app.temporal.startRepoDependencyScan('repo-1');
    expect(start).toHaveBeenCalledWith('RepoDependencyScanOneWorkflow', {
      args: [{ repoId: 'repo-1' }],
      taskQueue: 'engineering-workflow',
      workflowId: 'repo-dependency-scan-repo-1',
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  });

  it('treats an already-started scan as joined', async () => {
    const app = await build();
    start.mockImplementationOnce(async () => {
      throw Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' });
    });
    await expect(app.temporal.startRepoDependencyScan('repo-1')).resolves.toBeUndefined();
  });

  it('surfaces any other failure, for the caller to log and carry on', async () => {
    const app = await build();
    start.mockImplementationOnce(async () => {
      throw new Error('unreachable');
    });
    await expect(app.temporal.startRepoDependencyScan('repo-1')).rejects.toThrow('unreachable');
  });
});
