import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  children: [] as Array<Record<string, unknown>>,
  complete: vi.fn(),
  gatewayPost: vi.fn(),
  notices: [] as Array<Record<string, unknown>>,
  orch: { createdAt: new Date(1_000_000), status: 'ACTIVE', teamId: 'team-1' } as {
    createdAt: Date;
    status: string;
    teamId: string;
  } | null,
  orchUpdates: [] as Array<Record<string, unknown>>,
  runs: new Map<string, { endedAt: Date | null; id: string }>(),
  unseen: [] as string[],
  warn: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: { findMany: vi.fn(async () => []) },
    orchestration: {
      findUnique: vi.fn(async () => m.orch),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        m.orchUpdates.push(args);
        return { count: 1 };
      }),
    },
    orchestrationApproval: { count: vi.fn(async () => 0) },
    orchestrationChild: {
      count: vi.fn(async () => m.children.length),
      findMany: vi.fn(async () => m.children),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    orchestrationMessage: {
      count: vi.fn(async (_args: unknown) => 7),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        m.notices.push(data);
      }),
    },
    workflowRun: {
      findFirst: vi.fn(
        async ({ where }: { where: { workRequestId: string } }) =>
          m.runs.get(where.workRequestId) ?? null
      ),
    },
  },
}));
vi.mock('../lib/activityLog.js', () => ({ logWarn: m.warn }));
vi.mock('../lib/orchestrationChildren.js', () => ({
  completeOrchestrationChild: m.complete,
  findUnseenChildResults: vi.fn(async () => m.unseen),
  recordChildResult: vi.fn(async () => null),
}));
vi.mock('../lib/orchestrationGateway.js', () => ({
  createOrchestrationGateway: () => ({ post: m.gatewayPost }),
}));

import {
  beginOrchestrationRun,
  cancelOrchestrationChildren,
  recordOrchestrationStatus,
  refreshOrchestrationChildren,
} from './orchestrationControl.js';

const ORCH = '0b1c2d3e-0000-4000-8000-000000000001';
const child = (id: string, wr: string, status = 'RUNNING') => ({
  createdAt: new Date(),
  id,
  runId: null,
  status,
  workRequestId: wr,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.children = [];
  m.orch = { createdAt: new Date(1_000_000), status: 'ACTIVE', teamId: 'team-1' };
  m.orchUpdates = [];
  m.runs = new Map();
  m.unseen = [];
  m.notices = [];
  m.complete.mockReset();
});

describe('refreshOrchestrationChildren (the lost-signal backstop)', () => {
  it('completes a child whose run ended while the signal was lost', async () => {
    m.children = [child('c1', 'wr1'), child('c2', 'wr2')];
    m.runs.set('wr1', { endedAt: new Date(), id: 'run-1' });
    m.runs.set('wr2', { endedAt: null, id: 'run-2' });
    m.complete.mockResolvedValue({ childId: 'c1', orchestrationId: ORCH });
    const out = await refreshOrchestrationChildren({ orchestrationId: ORCH });
    expect(m.complete).toHaveBeenCalledTimes(1);
    expect(m.complete).toHaveBeenCalledWith('run-1');
    expect(out.finishedChildIds).toEqual(['c1']);
  });

  it('reports a finished child no turn has read yet', async () => {
    m.unseen = ['c7'];
    const out = await refreshOrchestrationChildren({ orchestrationId: ORCH });
    expect(out.finishedChildIds).toEqual(['c7']);
  });

  it('keeps going when one child cannot be reconciled', async () => {
    m.children = [child('c1', 'wr1'), child('c2', 'wr2')];
    m.runs.set('wr1', { endedAt: new Date(), id: 'run-1' });
    m.runs.set('wr2', { endedAt: new Date(), id: 'run-2' });
    m.complete
      .mockRejectedValueOnce(new Error('db'))
      .mockResolvedValueOnce({ childId: 'c2', orchestrationId: ORCH });
    const out = await refreshOrchestrationChildren({ orchestrationId: ORCH });
    expect(out.finishedChildIds).toEqual(['c2']);
  });
});

describe('beginOrchestrationRun', () => {
  it('does nothing for an orchestration that is over', async () => {
    m.orch = { createdAt: new Date(), status: 'CANCELLED', teamId: 'team-1' };
    expect((await beginOrchestrationRun({ orchestrationId: ORCH })).proceed).toBe(false);
  });

  it('reports the start time, turns taken and unread children, and wakes a WAITING one', async () => {
    m.orch = { createdAt: new Date(5_000), status: 'WAITING', teamId: 'team-1' };
    m.unseen = ['c3'];
    const out = await beginOrchestrationRun({ orchestrationId: ORCH });
    expect(out).toMatchObject({
      createdAtMs: 5000,
      proceed: true,
      turns: 7,
      unseenChildIds: ['c3'],
    });
    expect(m.orchUpdates[0]).toMatchObject({
      data: { status: 'ACTIVE' },
      where: { status: 'WAITING' },
    });
  });

  it('counts turns only by the marker a turn activity writes, never by any ORCHESTRATOR text', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    await beginOrchestrationRun({ orchestrationId: ORCH });
    // A gateway-written messageAgent row (ORCHESTRATOR, TEXT, no payload.turn) is not a turn.
    expect(vi.mocked(prisma.orchestrationMessage.count).mock.calls[0]?.[0]).toMatchObject({
      where: { kind: 'TEXT', payload: { gte: 1, path: ['turn'] }, role: 'ORCHESTRATOR' },
    });
  });
});

describe('recordOrchestrationStatus', () => {
  it('never overwrites a status the gateway already ended, and stamps endedAt on an end', async () => {
    await recordOrchestrationStatus({
      notice: { body: 'limit', code: 'TURN_LIMIT_REACHED' },
      orchestrationId: ORCH,
      status: 'COMPLETED',
    });
    const call = m.orchUpdates[0] as {
      data: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] } });
    expect(call.data.endedAt).toBeInstanceOf(Date);
    expect(m.notices[0]).toMatchObject({ kind: 'NOTICE', payload: { code: 'TURN_LIMIT_REACHED' } });
  });

  it('WAITING does not end it', async () => {
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'WAITING' });
    expect((m.orchUpdates[0] as { data: Record<string, unknown> }).data.endedAt).toBeUndefined();
  });
});

describe('cancelOrchestrationChildren', () => {
  it('cancels each running child through the gateway and survives a failure', async () => {
    m.children = [child('a', 'w1'), child('b', 'w2')];
    m.gatewayPost.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ status: 200 });
    const out = await cancelOrchestrationChildren({ orchestrationId: ORCH, token: 't' });
    expect(out.cancelled).toBe(1);
    expect(m.gatewayPost).toHaveBeenCalledWith(
      `/api/v1/orchestrations/${ORCH}/children/b/cancel`,
      {}
    );
  });

  it.each([401, 404, 409])(
    'treats a %i as already stopped or revoked: logged, not counted, not thrown',
    async (status) => {
      m.children = [child('a', 'w1')];
      m.gatewayPost.mockResolvedValueOnce({ status });
      const out = await cancelOrchestrationChildren({ orchestrationId: ORCH, token: 't' });
      expect(out.cancelled).toBe(0);
      expect(m.warn).toHaveBeenCalledWith(
        expect.stringContaining('already stopped'),
        expect.objectContaining({ childId: 'a', status })
      );
    }
  );

  it('logs any other refusal as a refusal rather than swallowing it', async () => {
    m.children = [child('a', 'w1')];
    m.gatewayPost.mockResolvedValueOnce({ status: 500 });
    const out = await cancelOrchestrationChildren({ orchestrationId: ORCH, token: 't' });
    expect(out.cancelled).toBe(0);
    expect(m.warn).toHaveBeenCalledWith(
      expect.stringContaining('refused'),
      expect.objectContaining({ status: 500 })
    );
  });
});
