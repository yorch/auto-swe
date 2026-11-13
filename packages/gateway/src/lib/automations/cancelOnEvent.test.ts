import type { InboundEvent } from '@auto-swe/shared/automation';
import { endpointOwnerKey } from '@auto-swe/shared/automation';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ audit: vi.fn(), finalized: vi.fn() }));
vi.mock('../auditLog.js', () => ({ writeAuditLog: m.audit }));
vi.mock('../metrics.js', () => ({ recordRunFinalized: m.finalized }));

import { cancelRunsOnEvent, RunCancelError } from './cancelOnEvent.js';

const ENDPOINT = { cancelOnTypes: ['incident.resolved'], id: 'ep-1' };
const event = (over: Partial<InboundEvent> = {}) =>
  ({
    endpointId: 'ep-1',
    id: 'evt-2',
    scope: 'PSVC',
    subject: 'PINC1',
    type: 'incident.resolved',
    ...over,
  }) as InboundEvent;

function notFound() {
  const err = new Error('gone');
  err.name = 'WorkflowNotFoundError';
  return err;
}

function fakeFastify(opts: {
  fires?: { temporalWorkflowId: string | null }[];
  runs?: { id: string; workflowId: string | null }[];
  updated?: number;
  cancel?: (id: string) => Promise<void>;
}) {
  const prisma = {
    activeWorkflow: { updateMany: vi.fn(async () => ({ count: 1 })) },
    automationFire: { findMany: vi.fn(async () => opts.fires ?? []) },
    workflowRun: {
      findMany: vi.fn(async () => opts.runs ?? []),
      updateMany: vi.fn(async () => ({ count: opts.updated ?? 1 })),
    },
  };
  const temporal = { cancelWorkflow: vi.fn(opts.cancel ?? (async () => undefined)) };
  const fastify = { log: { error: vi.fn() }, prisma, temporal } as unknown as FastifyInstance;
  return { fastify, prisma, temporal };
}

beforeEach(() => {
  m.audit.mockReset();
  m.finalized.mockReset();
});

describe('cancelRunsOnEvent', () => {
  it('does nothing for a type the endpoint does not cancel on', async () => {
    const { fastify, prisma } = fakeFastify({});
    expect(await cancelRunsOnEvent(fastify, ENDPOINT, event({ type: 'incident.triggered' }))).toBe(
      0
    );
    expect(prisma.automationFire.findMany).not.toHaveBeenCalled();
  });

  it('cancels the running runs this endpoint started for the same subject', async () => {
    const { fastify, prisma, temporal } = fakeFastify({
      fires: [{ temporalWorkflowId: 'wf-1' }],
      runs: [{ id: 'run-1', workflowId: 'wf-1' }],
    });
    expect(await cancelRunsOnEvent(fastify, ENDPOINT, event())).toBe(1);
    expect(prisma.automationFire.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          outcome: 'STARTED',
          ownerKey: endpointOwnerKey('ep-1'),
          subjectKey: 'PINC1',
        }),
      })
    );
    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'RUNNING', workflowId: { in: ['wf-1'] } } })
    );
    expect(temporal.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    // The workflow's cancellation path sets endedAt; only the status changes here.
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith({
      data: { status: 'CANCELLED' },
      where: { id: 'run-1', status: 'RUNNING' },
    });
    expect(m.finalized).toHaveBeenCalledWith('CANCELLED', 'gateway');
    expect(m.audit).toHaveBeenCalledWith(
      fastify,
      expect.objectContaining({ entityId: 'run-1', entityType: 'WorkflowRun' })
    );
  });

  it('cancels nothing when no run is still running (finished, or another subject)', async () => {
    const { fastify, temporal } = fakeFastify({ fires: [{ temporalWorkflowId: 'wf-1' }] });
    expect(await cancelRunsOnEvent(fastify, ENDPOINT, event())).toBe(0);
    expect(temporal.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('counts a run Temporal no longer knows as cancelled', async () => {
    const { fastify } = fakeFastify({
      cancel: async () => {
        throw notFound();
      },
      fires: [{ temporalWorkflowId: 'wf-1' }],
      runs: [{ id: 'run-1', workflowId: 'wf-1' }],
    });
    expect(await cancelRunsOnEvent(fastify, ENDPOINT, event())).toBe(1);
  });

  it('leaves a run Temporal refused to cancel RUNNING and throws, after cancelling the rest', async () => {
    const { fastify, prisma } = fakeFastify({
      cancel: async (id) => {
        if (id === 'wf-1') {
          throw new Error('unavailable');
        }
      },
      fires: [{ temporalWorkflowId: 'wf-1' }, { temporalWorkflowId: 'wf-2' }],
      runs: [
        { id: 'run-1', workflowId: 'wf-1' },
        { id: 'run-2', workflowId: 'wf-2' },
      ],
    });
    await expect(cancelRunsOnEvent(fastify, ENDPOINT, event())).rejects.toBeInstanceOf(
      RunCancelError
    );
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'run-2', status: 'RUNNING' } })
    );
  });

  it('does not count a run that finished meanwhile, so a redelivery is a no-op', async () => {
    const { fastify } = fakeFastify({
      fires: [{ temporalWorkflowId: 'wf-1' }],
      runs: [{ id: 'run-1', workflowId: 'wf-1' }],
      updated: 0,
    });
    expect(await cancelRunsOnEvent(fastify, ENDPOINT, event())).toBe(0);
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.finalized).not.toHaveBeenCalled();
  });
});
