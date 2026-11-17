import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '../test/warmAuthImports.js';
import { teamAttentionRoutes } from './teamAttention.js';

const ME = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const ASSIGNEE = '33333333-3333-4333-8333-333333333333';
const EX_MEMBER = '44444444-4444-4444-8444-444444444444';
const RUN_A = '55555555-5555-4555-8555-555555555551';
const RUN_B = '55555555-5555-4555-8555-555555555552';
const RUN_OK = '55555555-5555-4555-8555-555555555553';
const AUTH = { authorization: 'Bearer fake' };
const LIST_URL = `/api/v1/teams/${TEAM}/attention/failures`;
const ASSIGN_URL = `/api/v1/teams/${TEAM}/failure-assignments`;

const repository = {
  name: 'r',
  organizationName: 'acme',
  repoName: 'api',
  shares: [],
  team: { id: TEAM, name: 'Alpha', orgId: 'org-1', slug: 'alpha' },
};
const runRow = (overrides: Record<string, unknown> = {}) => ({
  _count: { humanSteps: 0 },
  connection: repository,
  endedAt: new Date('2026-06-02T10:00:00Z'),
  failureAssignment: null,
  id: RUN_A,
  launchedBy: { name: 'Ada' },
  launchedById: EX_MEMBER,
  startedAt: new Date('2026-06-02T09:00:00Z'),
  status: 'FAILED',
  template: { team: null },
  workflowId: 'wf-1',
  workRequest: {
    activeWorkflows: [],
    connection: null,
    description: 'Add endpoint',
    externalTicketId: 'JIRA-1',
    id: 'wr-1',
    isCrossRepo: false,
    title: null,
  },
  workRequestId: 'wr-1',
  ...overrides,
});

interface Fixture {
  assigneeIsMember?: boolean;
  createError?: Error;
  runs?: unknown[];
  teamRole: 'ADMIN' | 'LEAD' | 'ENGINEER';
}

async function build(fx: Fixture) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    $transaction: vi.fn(),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    failureAssignment: {
      create: vi.fn(async () => {
        if (fx.createError) {
          throw fx.createError;
        }
        return { createdAt: new Date('2026-06-03T12:00:00Z'), id: 'fa-1' };
      }),
    },
    teamMembership: {
      findMany: vi.fn().mockResolvedValue([{ userId: ME }, { userId: ASSIGNEE }]),
      findUnique: vi.fn(async (args: { where: { userId_teamId: { userId: string } } }) => {
        const { userId } = args.where.userId_teamId;
        if (userId === ME) {
          return { role: fx.teamRole };
        }
        return userId === ASSIGNEE && fx.assigneeIsMember !== false ? { role: 'ENGINEER' } : null;
      }),
    },
    workflowRun: { findMany: vi.fn().mockResolvedValue(fx.runs ?? []), update: vi.fn() },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: ME }),
  } as never);
  await app.register(teamAttentionRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, prisma };
}

let open: Awaited<ReturnType<typeof build>> | undefined;
async function call(fx: Fixture, method: 'GET' | 'POST', body?: Record<string, unknown>) {
  open = await build(fx);
  const res = await open.app.inject({
    headers: AUTH,
    method,
    url: method === 'GET' ? LIST_URL : ASSIGN_URL,
    ...(body ? { payload: body } : {}),
  });
  return { prisma: open.prisma, res };
}
afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

const unownedRuns = () => [
  runRow({ id: RUN_A }),
  runRow({
    endedAt: new Date('2026-06-02T12:00:00Z'),
    id: RUN_B,
    launchedBy: null,
    launchedById: null,
    workRequest: { ...runRow().workRequest, id: 'wr-2' },
    workRequestId: 'wr-2',
  }),
  // A current member's failure, an already assigned one and a success are not in the list.
  runRow({ id: 'mine', launchedById: ME, workRequestId: 'wr-3' }),
  runRow({ failureAssignment: { id: 'fa-0' }, id: 'taken', workRequestId: 'wr-4' }),
  runRow({ id: RUN_OK, status: 'SUCCESS', workRequestId: 'wr-5' }),
];

describe('GET /api/v1/teams/:id/attention/failures', () => {
  it('lists the unowned failures, newest first', async () => {
    const { res } = await call({ runs: unownedRuns(), teamRole: 'LEAD' }, 'GET');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([
      {
        failedAt: '2026-06-02T12:00:00.000Z',
        formerLauncherName: null,
        repoName: 'acme/api',
        requestId: 'wr-2',
        runId: RUN_B,
        title: 'Add endpoint',
      },
      {
        failedAt: '2026-06-02T10:00:00.000Z',
        formerLauncherName: 'Ada',
        repoName: 'acme/api',
        requestId: 'wr-1',
        runId: RUN_A,
        title: 'Add endpoint',
      },
    ]);
  });

  it('answers 403 to a team ENGINEER and reads no work', async () => {
    const { prisma, res } = await call({ runs: unownedRuns(), teamRole: 'ENGINEER' }, 'GET');
    expect(res.statusCode).toBe(403);
    expect(prisma.workflowRun.findMany).not.toHaveBeenCalled();
  });

  it('returns at most 100', async () => {
    const runs = Array.from({ length: 120 }, (_, i) =>
      runRow({ id: `run-${i}`, workRequestId: `wr-${i}` })
    );
    const { res } = await call({ runs, teamRole: 'LEAD' }, 'GET');
    expect(res.json().data).toHaveLength(100);
  });
});

describe('POST /api/v1/teams/:id/failure-assignments', () => {
  it('creates the assignment, audits it and never writes launchedById', async () => {
    const { prisma, res } = await call({ runs: unownedRuns(), teamRole: 'LEAD' }, 'POST', {
      assigneeId: ASSIGNEE,
      runId: RUN_A,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toEqual({
      assignedAt: '2026-06-03T12:00:00.000Z',
      assigneeId: ASSIGNEE,
      runId: RUN_A,
    });
    expect(prisma.failureAssignment.create).toHaveBeenCalledWith({
      data: { assignedById: ME, assigneeId: ASSIGNEE, teamId: TEAM, workflowRunId: RUN_A },
    });
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.configAuditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'CREATE',
      actorId: ME,
      entityId: 'fa-1',
      entityType: 'FailureAssignment',
    });
  });

  it('answers 409 NOT_UNOWNED_FAILURE for a run that is not an unowned failure', async () => {
    for (const runId of [RUN_OK, '55555555-5555-4555-8555-555555555599']) {
      const { prisma, res } = await call({ runs: unownedRuns(), teamRole: 'LEAD' }, 'POST', {
        assigneeId: ASSIGNEE,
        runId,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NOT_UNOWNED_FAILURE');
      expect(prisma.failureAssignment.create).not.toHaveBeenCalled();
      await open?.app.close();
    }
  });

  it('answers 409 when the run is already assigned', async () => {
    const runs = [runRow({ failureAssignment: { id: 'fa-0' }, id: RUN_A })];
    const { res } = await call({ runs, teamRole: 'LEAD' }, 'POST', {
      assigneeId: ASSIGNEE,
      runId: RUN_A,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_UNOWNED_FAILURE');
  });

  it('answers 409 when a concurrent assignment wins the unique constraint', async () => {
    const createError = Object.assign(new Error('unique'), { code: 'P2002' });
    const { prisma, res } = await call(
      { createError, runs: unownedRuns(), teamRole: 'LEAD' },
      'POST',
      {
        assigneeId: ASSIGNEE,
        runId: RUN_A,
      }
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_UNOWNED_FAILURE');
    expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('answers 422 ASSIGNEE_NOT_MEMBER when the assignee is not on the team', async () => {
    const { prisma, res } = await call(
      { assigneeIsMember: false, runs: unownedRuns(), teamRole: 'LEAD' },
      'POST',
      { assigneeId: ASSIGNEE, runId: RUN_A }
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ASSIGNEE_NOT_MEMBER');
    expect(prisma.failureAssignment.create).not.toHaveBeenCalled();
  });

  it('answers 403 to a team ENGINEER', async () => {
    const { prisma, res } = await call({ runs: unownedRuns(), teamRole: 'ENGINEER' }, 'POST', {
      assigneeId: ASSIGNEE,
      runId: RUN_A,
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.failureAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects ids that are not UUIDs', async () => {
    const { res } = await call({ teamRole: 'LEAD' }, 'POST', { assigneeId: 'x', runId: 'y' });
    expect(res.statusCode).toBe(400);
  });
});
