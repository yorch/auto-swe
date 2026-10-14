import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async () => ({}));
vi.mock('./temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start } }),
}));
vi.mock('@temporalio/client', () => ({
  WorkflowIdConflictPolicy: { USE_EXISTING: 'USE_EXISTING' },
}));

import { startDatasetScreen } from './evalScreenStart.js';

beforeEach(() => start.mockReset());

describe('startDatasetScreen', () => {
  it("starts or joins the dataset's one screen", async () => {
    start.mockResolvedValue({});
    await startDatasetScreen('d1');
    expect(start).toHaveBeenCalledWith('EvalScreenWorkflow', {
      args: [{ datasetId: 'd1' }],
      taskQueue: 'engineering-workflow',
      workflowId: 'eval-screen-d1',
      workflowIdConflictPolicy: 'USE_EXISTING',
    });
  });

  it('treats an already-started screen as joined', async () => {
    start.mockRejectedValue(
      Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' })
    );
    await expect(startDatasetScreen('d1')).resolves.toBeUndefined();
  });

  it('surfaces any other failure to its caller', async () => {
    start.mockRejectedValue(new Error('unreachable'));
    await expect(startDatasetScreen('d1')).rejects.toThrow('unreachable');
  });
});
