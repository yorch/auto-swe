import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async (..._args: unknown[]) => ({}));
const signal = vi.fn(async (_name: string) => {});
const getHandle = vi.fn((_id: string) => ({ signal }));

vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = { getHandle, start };
  },
  Connection: { connect: vi.fn(async () => ({})) },
  ScheduleClient: class {},
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdConflictPolicy: {},
  WorkflowIdReusePolicy: {},
  WorkflowNotFoundError: class extends Error {},
}));

import {
  CAMPAIGN_CANCEL_SIGNAL,
  type CampaignWorkflowInput,
} from '@auto-swe/shared/types/workflow';
import temporalPlugin from './temporal.js';

async function build() {
  const app = Fastify();
  await app.register(temporalPlugin);
  await app.ready();
  await app.temporalConnection.whenConnected();
  return app;
}

beforeEach(() => {
  start.mockReset();
  signal.mockReset();
  getHandle.mockClear();
});

describe('startCampaignWorkflow', () => {
  it('starts CampaignWorkflow on the engineering queue under the given id', async () => {
    const app = await build();
    const input = { campaignId: 'c1' } as CampaignWorkflowInput;
    await app.temporal.startCampaignWorkflow('campaign-c1', input);
    expect(start).toHaveBeenCalledWith('CampaignWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowExecutionTimeout: '30d',
      workflowId: 'campaign-c1',
    });
  });

  it('surfaces a start failure so the launch can compensate', async () => {
    start.mockRejectedValueOnce(
      Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' })
    );
    const app = await build();
    await expect(
      app.temporal.startCampaignWorkflow('campaign-c1', {} as CampaignWorkflowInput)
    ).rejects.toThrow('started');
  });
});

describe('signalCampaignCancel', () => {
  it('sends the shared cancel signal name to the campaign workflow', async () => {
    const app = await build();
    await app.temporal.signalCampaignCancel('campaign-c1');
    expect(getHandle).toHaveBeenCalledWith('campaign-c1');
    expect(signal).toHaveBeenCalledWith(CAMPAIGN_CANCEL_SIGNAL);
    expect(CAMPAIGN_CANCEL_SIGNAL).toBe('campaignCancelSignal');
  });

  it('counts a workflow that has already closed as success', async () => {
    signal.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'WorkflowNotFoundError' })
    );
    const app = await build();
    await expect(app.temporal.signalCampaignCancel('campaign-c1')).resolves.toBe('not-running');
  });

  it('still surfaces any other failure', async () => {
    signal.mockRejectedValueOnce(new Error('unreachable'));
    const app = await build();
    await expect(app.temporal.signalCampaignCancel('campaign-c1')).rejects.toThrow('unreachable');
  });
});
