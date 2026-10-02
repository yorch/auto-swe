import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

const describeMock = vi.fn();
vi.mock('./temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { getHandle: () => ({ describe: describeMock }) } }),
}));

import { WorkflowNotFoundError } from '@temporalio/client';
import { workflowIsRunning } from './agentRunSlots.js';

beforeEach(() => {
  describeMock.mockReset();
});

describe('workflowIsRunning (the worker side of "is this workflow gone")', () => {
  it('maps a WorkflowNotFoundError to not running, so the row is closed', async () => {
    describeMock.mockRejectedValue(new WorkflowNotFoundError('not found', 'wf-1', undefined));
    expect(await workflowIsRunning('wf-1')).toBe(false);
  });

  it.each(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'])(
    'a %s execution is not running',
    async (name) => {
      describeMock.mockResolvedValue({ status: { name } });
      expect(await workflowIsRunning('wf-1')).toBe(false);
    }
  );

  it.each(['RUNNING', 'CONTINUED_AS_NEW', 'UNSPECIFIED', 'SOMETHING_NEW'])(
    'keeps the slot for %s',
    async (name) => {
      describeMock.mockResolvedValue({ status: { name } });
      expect(await workflowIsRunning('wf-1')).toBe(true);
    }
  );

  it('lets any other failure through, so the caller keeps counting the row', async () => {
    describeMock.mockRejectedValue(new Error('unavailable'));
    await expect(workflowIsRunning('wf-1')).rejects.toThrow('unavailable');
  });
});
