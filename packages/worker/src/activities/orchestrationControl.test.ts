import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  children: [] as Array<Record<string, unknown>>,
  complete: vi.fn(),
  gatewayPost: vi.fn(),
  ledger: [] as Array<Record<string, unknown>>,
  markerCount: 7,
  notices: [] as Array<Record<string, unknown>>,
  orch: { createdAt: new Date(1_000_000), status: 'ACTIVE', teamId: 'team-1' } as {
    createdAt: Date;
    status: string;
    teamId: string;
  } | null,
  orchUpdates: [] as Array<Record<string, unknown>>,
  runs: new Map<string, { endedAt: Date | null; id: string }>(),
  textTurnCount: 0,
  unseen: [] as string[],
  unseenGrace: [] as number[],
  warn: vi.fn(),
  workflowId: null as string | null,
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args: Record<string, unknown>) => {
        m.ledger.push(args);
        return { count: 1 };
      }),
    },
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
      count: vi.fn(async (args: { where: { kind: string } }) =>
        args.where.kind === 'NOTICE' ? m.markerCount : m.textTurnCount
      ),
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
  findUnseenChildResults: vi.fn(async (_o: string, grace: number) => {
    m.unseenGrace.push(grace);
    return m.unseen;
  }),
  recordChildResult: vi.fn(async () => null),
}));
vi.mock('../lib/orchestrationIdentity.js', async (orig) => {
  const real = await orig<typeof import('../lib/orchestrationIdentity.js')>();
  return {
    ...real,
    // Stands in for the activity context: `null` is "not inside an activity".
    assertCurrentWorkflowOwns: (orchestrationId: string) => {
      if (m.workflowId !== null) {
        real.assertOwnWorkflowId(orchestrationId, m.workflowId);
      }
    },
  };
});
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
  m.unseenGrace = [];
  m.ledger = [];
  m.markerCount = 7;
  m.textTurnCount = 0;
  m.notices = [];
  m.workflowId = null;
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

  it('re-reports a result a turn deferred (still unread) once the signal grace has passed', async () => {
    // A deferred result is unread, so the same lookup that finds a lost signal finds it; the
    // workflow also reports it itself right after the turn that deferred it.
    m.unseen = ['c6', 'c7', 'c8'];
    const out = await refreshOrchestrationChildren({ orchestrationId: ORCH });
    expect(out.finishedChildIds).toEqual(['c6', 'c7', 'c8']);
    expect(m.unseenGrace).toEqual([90_000]);
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

describe('the workflow that drives an orchestration', () => {
  const FOREIGN = 'my-own-workflow';

  it.each([
    ['beginOrchestrationRun', () => beginOrchestrationRun({ orchestrationId: ORCH })],
    ['refreshOrchestrationChildren', () => refreshOrchestrationChildren({ orchestrationId: ORCH })],
    [
      'recordOrchestrationStatus',
      () => recordOrchestrationStatus({ orchestrationId: ORCH, status: 'WAITING' }),
    ],
    ['cancelOrchestrationChildren', () => cancelOrchestrationChildren({ orchestrationId: ORCH })],
  ])(
    '%s refuses a workflow that is not orch-<id>, before reading or writing anything',
    async (_n, run) => {
      m.workflowId = FOREIGN;
      await expect(run()).rejects.toMatchObject({ nonRetryable: true });
      expect(m.orchUpdates).toEqual([]);
      expect(m.ledger).toEqual([]);
      expect(m.complete).not.toHaveBeenCalled();
      expect(m.gatewayPost).not.toHaveBeenCalled();
    }
  );

  it('refuses the workflow of another orchestration', async () => {
    m.workflowId = 'orch-0b1c2d3e-0000-4000-8000-000000000002';
    await expect(beginOrchestrationRun({ orchestrationId: ORCH })).rejects.toThrow();
  });

  it('proceeds under its own id', async () => {
    m.workflowId = `orch-${ORCH}`;
    expect((await beginOrchestrationRun({ orchestrationId: ORCH })).proceed).toBe(true);
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

  it('counts every turn by its marker, tool-only and failed ones included', async () => {
    const { prisma } = await import('@auto-swe/shared/db');
    m.markerCount = 9;
    const out = await beginOrchestrationRun({ orchestrationId: ORCH });
    expect(out.turns).toBe(9);
    // The marker is a hidden SYSTEM NOTICE; a gateway-written messageAgent row (ORCHESTRATOR, TEXT,
    // no payload.turn) is not a turn.
    const wheres = vi
      .mocked(prisma.orchestrationMessage.count)
      .mock.calls.map((c) => (c[0] as { where: unknown }).where);
    expect(wheres).toContainEqual({
      kind: 'NOTICE',
      orchestrationId: ORCH,
      payload: { equals: true, path: ['marker'] },
      role: 'SYSTEM',
    });
    expect(wheres).toContainEqual(
      expect.objectContaining({ kind: 'TEXT', payload: { gte: 1, path: ['turn'] } })
    );
  });

  it('still counts turns recorded before markers existed, without counting a turn twice', async () => {
    m.markerCount = 3;
    m.textTurnCount = 12;
    expect((await beginOrchestrationRun({ orchestrationId: ORCH })).turns).toBe(12);
    m.markerCount = 15;
    m.textTurnCount = 5;
    expect((await beginOrchestrationRun({ orchestrationId: ORCH })).turns).toBe(15);
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

describe('the orchestrator ledger row (the in-flight cap of the launcher)', () => {
  const NOT_TERMINAL = { notIn: ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'] };
  const WF = `orch-${ORCH}`;

  it('closes it as COMPLETED when the orchestration idles out or completes', async () => {
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'WAITING' });
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'COMPLETED' });
    expect(m.ledger).toEqual([
      {
        data: { currentStatus: 'COMPLETED' },
        where: { currentStatus: NOT_TERMINAL, temporalWorkflowId: WF },
      },
      {
        data: { currentStatus: 'COMPLETED' },
        where: { currentStatus: NOT_TERMINAL, temporalWorkflowId: WF },
      },
    ]);
  });

  it('closes it as CANCELLED or FAILED, never overwriting a terminal status', async () => {
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'CANCELLED' });
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'FAILED' });
    expect(m.ledger.map((l) => (l.data as { currentStatus: string }).currentStatus)).toEqual([
      'CANCELLED',
      'FAILED',
    ]);
    // Conditional on non-terminal: a CANCELLED row the gateway wrote is left as it is.
    expect(
      m.ledger.every(
        (l) =>
          JSON.stringify((l.where as { currentStatus: unknown }).currentStatus) ===
          JSON.stringify(NOT_TERMINAL)
      )
    ).toBe(true);
  });

  it('reopens only a row it closed as COMPLETED, when the orchestration is not over', async () => {
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'ACTIVE' });
    expect(m.ledger).toEqual([
      {
        data: { currentStatus: 'IMPLEMENTING' },
        where: { currentStatus: 'COMPLETED', temporalWorkflowId: WF },
      },
    ]);
    m.ledger = [];
    m.orch = { createdAt: new Date(), status: 'CANCELLED', teamId: 'team-1' };
    await recordOrchestrationStatus({ orchestrationId: ORCH, status: 'ACTIVE' });
    expect(m.ledger).toEqual([]);
  });

  it('is put back in flight when the workflow restarts', async () => {
    m.orch = { createdAt: new Date(5_000), status: 'WAITING', teamId: 'team-1' };
    await beginOrchestrationRun({ orchestrationId: ORCH });
    expect(m.ledger).toEqual([
      {
        data: { currentStatus: 'IMPLEMENTING' },
        where: { currentStatus: 'COMPLETED', temporalWorkflowId: WF },
      },
    ]);
  });

  it('is not reopened for an orchestration that is over', async () => {
    m.orch = { createdAt: new Date(), status: 'CANCELLED', teamId: 'team-1' };
    await beginOrchestrationRun({ orchestrationId: ORCH });
    expect(m.ledger).toEqual([]);
  });
});

describe('cancelOrchestrationChildren', () => {
  it('cancels each running child through the gateway and survives a failure', async () => {
    m.children = [child('a', 'w1'), child('b', 'w2')];
    m.gatewayPost.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ status: 200 });
    const out = await cancelOrchestrationChildren({ orchestrationId: ORCH });
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
      const out = await cancelOrchestrationChildren({ orchestrationId: ORCH });
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
    const out = await cancelOrchestrationChildren({ orchestrationId: ORCH });
    expect(out.cancelled).toBe(0);
    expect(m.warn).toHaveBeenCalledWith(
      expect.stringContaining('refused'),
      expect.objectContaining({ status: 500 })
    );
  });
});
