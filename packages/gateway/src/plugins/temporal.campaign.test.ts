import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const start = vi.fn(async (..._args: unknown[]) => ({}));
const signal = vi.fn(async (_name: string) => {});
const describe_ = vi.fn(async () => ({}));
const signalWithStart = vi.fn(async (..._args: unknown[]) => ({}));
const getHandle = vi.fn((_id: string) => ({ describe: describe_, signal }));

vi.mock('@temporalio/client', () => ({
  Client: class {
    workflow = { getHandle, signalWithStart, start };
  },
  Connection: { connect: vi.fn(async () => ({})) },
  ScheduleClient: class {},
  ScheduleNotFoundError: class extends Error {},
  ScheduleOverlapPolicy: {},
  WorkflowIdConflictPolicy: {},
  WorkflowIdReusePolicy: {
    ALLOW_DUPLICATE: 'ALLOW_DUPLICATE',
    REJECT_DUPLICATE: 'REJECT_DUPLICATE',
  },
  WorkflowNotFoundError: class extends Error {},
}));

import {
  CAMPAIGN_CANCEL_SIGNAL,
  CAMPAIGN_CONTROL_SIGNAL,
  CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL,
  type CampaignReconcilerInput,
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
  signalWithStart.mockReset();
  describe_.mockReset();
  describe_.mockResolvedValue({});
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

describe('startCampaignReconcilerWorkflow', () => {
  it('starts CampaignReconcilerWorkflow under the same `campaign-<id>` id, with no execution timeout', async () => {
    const app = await build();
    const input: CampaignReconcilerInput = {
      campaignId: 'c1',
      campaignWorkflowId: 'campaign-c1',
    };
    await app.temporal.startCampaignReconcilerWorkflow('campaign-c1', input);
    expect(start).toHaveBeenCalledWith('CampaignReconcilerWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowId: 'campaign-c1',
    });
  });

  it('surfaces a start failure so the launch can compensate', async () => {
    start.mockRejectedValueOnce(new Error('unreachable'));
    const app = await build();
    await expect(
      app.temporal.startCampaignReconcilerWorkflow('campaign-c1', {} as CampaignReconcilerInput)
    ).rejects.toThrow('unreachable');
  });
});

describe('signalCampaignWorkflow', () => {
  it('sends the named signal with its payload to the campaign’s workflow', async () => {
    const app = await build();
    await expect(
      app.temporal.signalCampaignWorkflow('campaign-c1', CAMPAIGN_CONTROL_SIGNAL, {
        action: 'pause',
      })
    ).resolves.toBe('signalled');
    expect(getHandle).toHaveBeenCalledWith('campaign-c1');
    expect(signal).toHaveBeenCalledWith('campaignControl', { action: 'pause' });
    expect(CAMPAIGN_PULL_REQUEST_CHANGED_SIGNAL).toBe('campaignPullRequestChanged');
  });

  it('counts a workflow that has already closed as not running, and surfaces any other failure', async () => {
    signal.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'WorkflowNotFoundError' })
    );
    const app = await build();
    await expect(
      app.temporal.signalCampaignWorkflow('campaign-c1', CAMPAIGN_CONTROL_SIGNAL, {})
    ).resolves.toBe('not-running');
    signal.mockRejectedValueOnce(new Error('unreachable'));
    await expect(
      app.temporal.signalCampaignWorkflow('campaign-c1', CAMPAIGN_CONTROL_SIGNAL, {})
    ).rejects.toThrow('unreachable');
  });
});

describe('signalCampaignWorkflow with a start input (signal-with-start)', () => {
  const input: CampaignReconcilerInput = { campaignId: 'c1', campaignWorkflowId: 'campaign-c1' };

  it('signals a running reconciler, or starts one under the same id when none runs, in one call', async () => {
    const app = await build();
    await expect(
      app.temporal.signalCampaignWorkflow(
        'campaign-c1',
        CAMPAIGN_CONTROL_SIGNAL,
        { action: 'pause' },
        input
      )
    ).resolves.toBe('signalled');
    expect(signalWithStart).toHaveBeenCalledWith('CampaignReconcilerWorkflow', {
      args: [input],
      signal: 'campaignControl',
      signalArgs: [{ action: 'pause' }],
      taskQueue: 'engineering-workflow',
      workflowId: 'campaign-c1',
      // A closed or terminated reconciler leaves the id free to start again.
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it('surfaces a failure of the combined call', async () => {
    signalWithStart.mockRejectedValueOnce(new Error('unreachable'));
    const app = await build();
    await expect(
      app.temporal.signalCampaignWorkflow('campaign-c1', CAMPAIGN_CONTROL_SIGNAL, {}, input)
    ).rejects.toThrow('unreachable');
  });

  it('never starts a workflow when no start input is given', async () => {
    signal.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'WorkflowNotFoundError' })
    );
    const app = await build();
    await expect(
      app.temporal.signalCampaignWorkflow('campaign-c1', CAMPAIGN_CONTROL_SIGNAL, {})
    ).resolves.toBe('not-running');
    expect(signalWithStart).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('startRunnableWorkflow reuse policy', () => {
  const input = { request: {}, templateId: 't', templateVersion: 1 } as never;

  it('rejects a reused id only when asked, and leaves every other caller on the default', async () => {
    const app = await build();
    await app.temporal.startRunnableWorkflow('wf-1', input, { rejectReuse: true });
    expect(start).toHaveBeenLastCalledWith('RunnableWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowId: 'wf-1',
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
    });
    await app.temporal.startRunnableWorkflow('wf-2', input);
    expect(start).toHaveBeenLastCalledWith('RunnableWorkflow', {
      args: [input],
      taskQueue: 'engineering-workflow',
      workflowId: 'wf-2',
    });
    await app.temporal.startRunnableWorkflow('wf-3', input, {});
    expect(start.mock.lastCall?.[1]).not.toHaveProperty('workflowIdReusePolicy');
  });
});

describe('workflowExecutionExists', () => {
  it('is true for any execution, false for none, and propagates every other failure', async () => {
    const app = await build();
    await expect(app.temporal.workflowExecutionExists('wf-1')).resolves.toBe(true);
    expect(getHandle).toHaveBeenCalledWith('wf-1');
    describe_.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'WorkflowNotFoundError' })
    );
    await expect(app.temporal.workflowExecutionExists('wf-1')).resolves.toBe(false);
    describe_.mockRejectedValueOnce(new Error('unreachable'));
    await expect(app.temporal.workflowExecutionExists('wf-1')).rejects.toThrow('unreachable');
  });
});

describe('workflowExecutionState', () => {
  it('tells a running execution from a closed one and from none, and propagates other failures', async () => {
    const app = await build();
    describe_.mockResolvedValueOnce({ status: { name: 'RUNNING' } });
    await expect(app.temporal.workflowExecutionState('wf-1')).resolves.toBe('running');
    describe_.mockResolvedValueOnce({ status: { name: 'COMPLETED' } });
    await expect(app.temporal.workflowExecutionState('wf-1')).resolves.toBe('closed');
    describe_.mockResolvedValueOnce({ status: { name: 'TERMINATED' } });
    await expect(app.temporal.workflowExecutionState('wf-1')).resolves.toBe('closed');
    describe_.mockRejectedValueOnce(
      Object.assign(new Error('not found'), { name: 'WorkflowNotFoundError' })
    );
    await expect(app.temporal.workflowExecutionState('wf-1')).resolves.toBe('none');
    describe_.mockRejectedValueOnce(new Error('unreachable'));
    await expect(app.temporal.workflowExecutionState('wf-1')).rejects.toThrow('unreachable');
  });
});
