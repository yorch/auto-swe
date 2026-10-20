import { Prisma } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubBaseUrl: async () => 'https://github.com',
  resolveWebUrl: () => 'https://app.example.com',
}));
vi.mock('../lib/slackNotify.js', () => ({ notifySlackHumanStep: vi.fn() }));

const { prisma, txCreateMany, txCreateStep } = vi.hoisted(() => {
  const txCreateMany = vi.fn(async () => ({ count: 1 }));
  const txCreateStep = vi.fn(async () => ({ id: 'step-1', kind: 'APPROVAL' }));
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        outboundDelivery: { createMany: txCreateMany },
        workflowHumanStep: { create: txCreateStep },
      })
    ),
    activeWorkflow: { findFirst: vi.fn(async () => ({ costUsdAccrued: 0.5 })) },
    outboundDelivery: { createMany: vi.fn() },
    runCallback: { findUnique: vi.fn() },
    workflowHumanStep: {
      create: vi.fn(async () => ({ id: 'step-plain', kind: 'APPROVAL' })),
      findFirst: vi.fn(async () => ({ id: 'step-existing' })),
    },
    workflowRun: {
      findUnique: vi.fn(async () => ({
        startedAt: new Date('2026-10-14T00:00:00Z'),
        status: 'RUNNING',
        workflowId: 'wf-1',
        workRequestId: 'wr-1',
      })),
    },
  };
  return { prisma, txCreateMany, txCreateStep };
});
vi.mock('@auto-swe/shared/db', () => ({ prisma }));

import { notifySlackHumanStep } from '../lib/slackNotify.js';
import { createHumanStep } from './state.js';

const INPUT = {
  kind: 'APPROVAL' as const,
  nodeId: 'approve',
  runId: 'run-1',
  signalName: 'approve',
  title: 'Ship it?',
};

describe('createHumanStep and the run.waiting_for_human callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.runCallback.findUnique.mockResolvedValue({
      context: { k: 1 },
      endpoint: { events: ['run.completed', 'run.waiting_for_human'], id: 'ep-1' },
      id: 'cb-1',
      launchedBy: { id: 'user-1', kind: 'user' },
      workflowId: 'wf-1',
    });
  });

  it('writes the delivery in the same transaction as the step', async () => {
    await createHumanStep(INPUT);
    expect(txCreateStep).toHaveBeenCalledTimes(1);
    expect(prisma.workflowHumanStep.create).not.toHaveBeenCalled();
    expect(txCreateMany).toHaveBeenCalledTimes(1);
    const row = (txCreateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown>[] }])[0]
      .data[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      dedupeKey: 'run-1:run.waiting_for_human:step-1',
      event: 'run.waiting_for_human',
    });
    expect(row.payload).toMatchObject({
      context: { k: 1 },
      humanStep: {
        dashboardUrl: 'https://app.example.com/approvals',
        id: 'step-1',
        kind: 'APPROVAL',
      },
      launchedBy: { id: 'user-1', kind: 'user' },
      run: { costUsd: 0.5, endedAt: null, status: 'RUNNING' },
      type: 'run.waiting_for_human',
    });
    expect(notifySlackHumanStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 'step-1' })
    );
  });

  it('writes no second delivery when a retry finds the step already created', async () => {
    txCreateStep.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { clientVersion: 'x', code: 'P2002' })
    );
    // The insert never runs: the step's create failed first, and the transaction rolled back.
    await createHumanStep(INPUT);
    expect(txCreateMany).not.toHaveBeenCalled();
    expect(notifySlackHumanStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: 'step-existing' })
    );
  });

  it('uses no transaction when the endpoint did not subscribe to the event', async () => {
    prisma.runCallback.findUnique.mockResolvedValue({
      context: null,
      endpoint: { events: ['run.completed'], id: 'ep-1' },
      id: 'cb-1',
      launchedBy: { id: 'user-1', kind: 'user' },
      workflowId: 'wf-1',
    });
    await createHumanStep(INPUT);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.workflowHumanStep.create).toHaveBeenCalledTimes(1);
  });

  it('stores the request-changes option on an APPROVAL step only when asked', async () => {
    await createHumanStep({ ...INPUT, allowRequestChanges: true });
    expect(txCreateStep).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          options: [{ label: 'Request changes', value: 'request_changes' }],
        }),
      })
    );
    // Without the flag the approval step carries no options — the action fails closed.
    txCreateStep.mockClear();
    await createHumanStep(INPUT);
    expect(
      (txCreateStep.mock.calls[0] as unknown as [{ data: { options?: unknown } }])[0]?.data.options
    ).toBeUndefined();
  });
});
