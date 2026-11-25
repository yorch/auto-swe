import { Prisma } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthedApp } from '../test/authedApp.js';
import { teamBudgetRequestRoutes } from './teamBudgetRequests.js';

const TEAM = '00000000-0000-4000-8000-000000000011';
const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PREFIX = '/api/v1/teams';
const CREATED_AT = new Date('2026-11-16T10:00:00.000Z');

interface Opts {
  platformRole?: string;
  teamRole?: 'ADMIN' | 'LEAD' | 'MEMBER' | null;
  orgRole?: 'ADMIN' | 'MEMBER' | null;
}

interface Row {
  id: string;
  reason: string;
  requestedBy: { id: string; name: string | null };
  createdAt: Date;
  resolvedAt: Date | null;
}

function build(opts: Opts = {}) {
  const rows: Row[] = [];
  const create = vi.fn(async ({ data }: { data: { reason: string } }) => {
    if (rows.some((r) => r.resolvedAt === null)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        clientVersion: 'test',
        code: 'P2002',
      });
    }
    const row: Row = {
      createdAt: CREATED_AT,
      id: '00000000-0000-4000-8000-0000000000b1',
      reason: data.reason,
      requestedBy: { id: USER, name: 'Ada' },
      resolvedAt: null,
    };
    rows.push(row);
    return row;
  });
  const findMany = vi.fn(async (_args: unknown) => rows.filter((r) => r.resolvedAt === null));
  const findFirst = vi.fn(
    async (_args: unknown) => rows.find((r) => r.resolvedAt === null) ?? null
  );
  // A dismissal matches only a pending request of the team named in the where clause.
  const updateMany = vi.fn(
    async ({
      data,
      where,
    }: {
      data: { resolvedAt: Date };
      where: { id: string; teamId: string; resolvedAt: null; requestedById?: string };
    }) => {
      const hit =
        where.teamId === TEAM
          ? rows.find(
              (r) =>
                r.id === where.id &&
                !r.resolvedAt &&
                (where.requestedById === undefined || r.requestedBy.id === where.requestedById)
            )
          : null;
      if (hit) {
        hit.resolvedAt = data.resolvedAt;
      }
      return { count: hit ? 1 : 0 };
    }
  );
  const prisma = {
    // A rolled-back transaction leaves no row behind, as in Postgres.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const kept = rows.length;
      try {
        return await fn(prisma);
      } catch (err) {
        rows.length = kept;
        throw err;
      }
    }),
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    organizationMembership: {
      findMany: vi.fn(async () => (opts.orgRole ? [{ orgId: ORG, role: opts.orgRole }] : [])),
      findUnique: vi.fn(async () => (opts.orgRole ? { role: opts.orgRole } : null)),
    },
    team: {
      // The permissions loader's read of the team itself.
      findMany: vi.fn(async () => [{ id: TEAM, isActive: true, orgId: ORG }]),
      findUnique: vi.fn(async () => ({
        budgetAlertThresholdPercent: null,
        id: TEAM,
        memberships: opts.teamRole ? [{ role: opts.teamRole }] : [],
        monthlyBudgetUsdCents: null,
        name: 'Payments',
        orgId: ORG,
      })),
    },
    teamBudgetRequest: { create, findFirst, findMany, updateMany },
    teamMembership: {
      // The permissions loader's read of the caller's membership.
      findMany: vi.fn(async () => (opts.teamRole ? [{ role: opts.teamRole, teamId: TEAM }] : [])),
      findUnique: vi.fn(async () => (opts.teamRole ? { role: opts.teamRole } : null)),
    },
  };
  const app = makeAuthedApp({ prisma, role: opts.platformRole ?? 'ENGINEER', sub: USER });
  app.register(teamBudgetRequestRoutes, { prefix: PREFIX });
  return { app, create, findFirst, findMany, prisma, rows, updateMany };
}

afterEach(() => vi.clearAllMocks());

const post = (app: ReturnType<typeof build>['app'], body: unknown) =>
  app.inject({
    method: 'POST',
    payload: body as object,
    url: `${PREFIX}/${TEAM}/budget-requests`,
  });
const list = (app: ReturnType<typeof build>['app']) =>
  app.inject({ method: 'GET', url: `${PREFIX}/${TEAM}/budget-requests` });

describe('POST /teams/:id/budget-requests', () => {
  it('records the request for a team LEAD and returns no amount', async () => {
    const { app, create } = build({ teamRole: 'LEAD' });
    await app.ready();
    const res = await post(app, { reason: '  Launch week needs more headroom  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toEqual({
      createdAt: CREATED_AT.toISOString(),
      id: '00000000-0000-4000-8000-0000000000b1',
      reason: 'Launch week needs more headroom',
      requestedBy: { id: USER, name: 'Ada' },
    });
    expect(res.body).not.toMatch(/cents|usd/i);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { reason: 'Launch week needs more headroom', requestedById: USER, teamId: TEAM },
    });
  });

  it('answers 409 REQUEST_PENDING when one is already pending', async () => {
    const { app } = build({ teamRole: 'LEAD' });
    await app.ready();
    expect((await post(app, { reason: 'first' })).statusCode).toBe(201);
    const second = await post(app, { reason: 'second' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REQUEST_PENDING');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['501 characters', 'x'.repeat(501)],
  ])('rejects a reason that is %s', async (_name, reason) => {
    const { app, create } = build({ teamRole: 'LEAD' });
    await app.ready();
    expect((await post(app, { reason })).statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('accepts a reason of exactly 500 characters', async () => {
    const { app } = build({ teamRole: 'LEAD' });
    await app.ready();
    expect((await post(app, { reason: 'x'.repeat(500) })).statusCode).toBe(201);
  });

  it('refuses a team ENGINEER', async () => {
    const { app, create } = build({ teamRole: 'MEMBER' });
    await app.ready();
    expect((await post(app, { reason: 'please' })).statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes an audit row that does not carry the reason', async () => {
    const { app, prisma } = build({ teamRole: 'LEAD' });
    await app.ready();
    await post(app, { reason: 'a secret-ish explanation' });
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    const arg = JSON.stringify(prisma.configAuditLog.create.mock.calls[0]?.[0]);
    expect(arg).toContain('TeamBudgetRequest');
    expect(arg).toContain('CREATE');
    expect(arg).not.toContain('secret-ish');
  });
});

describe('POST /teams/:id/budget-requests atomicity', () => {
  it('leaves no request behind when the audit write fails', async () => {
    const { app, prisma, rows } = build({ teamRole: 'LEAD' });
    await app.ready();
    prisma.configAuditLog.create.mockRejectedValueOnce(new Error('audit down'));
    const res = await post(app, { reason: 'need more' });
    expect(res.statusCode).toBe(500);
    expect(rows).toHaveLength(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('GET /teams/:id/budget-requests', () => {
  async function seeded(opts: Opts) {
    const built = build(opts);
    built.rows.push({
      createdAt: CREATED_AT,
      id: '00000000-0000-4000-8000-0000000000b2',
      reason: 'more please',
      requestedBy: { id: USER, name: null },
      resolvedAt: null,
    });
    await built.app.ready();
    return built;
  }

  it('lists the pending requests, oldest first, for a team ADMIN', async () => {
    const { app, findMany } = await seeded({ teamRole: 'ADMIN' });
    const res = await list(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        createdAt: CREATED_AT.toISOString(),
        id: '00000000-0000-4000-8000-0000000000b2',
        reason: 'more please',
        requestedBy: { id: USER, name: null },
      },
    ]);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: { createdAt: 'asc' },
      where: { resolvedAt: null, teamId: TEAM },
    });
  });

  it('lists them for an ORG_ADMIN who is not on the team', async () => {
    const { app } = await seeded({ orgRole: 'ADMIN' });
    expect((await list(app)).statusCode).toBe(200);
  });

  it('refuses a team LEAD', async () => {
    const { app } = await seeded({ teamRole: 'LEAD' });
    const res = await list(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});

describe('POST /teams/:id/budget-requests/:requestId/dismiss', () => {
  const REQUEST = '00000000-0000-4000-8000-0000000000b2';
  const dismiss = (app: ReturnType<typeof build>['app'], id = REQUEST, team = TEAM) =>
    app.inject({ method: 'POST', url: `${PREFIX}/${team}/budget-requests/${id}/dismiss` });

  async function seeded(opts: Opts) {
    const built = build(opts);
    built.rows.push({
      createdAt: CREATED_AT,
      id: REQUEST,
      reason: 'more please',
      requestedBy: { id: USER, name: null },
      resolvedAt: null,
    });
    await built.app.ready();
    return built;
  }

  it('resolves a pending request for a team ADMIN and audits it in the transaction', async () => {
    const { app, prisma, rows, updateMany } = await seeded({ teamRole: 'ADMIN' });
    const res = await dismiss(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id: REQUEST });
    expect(updateMany).toHaveBeenCalledWith({
      data: { resolvedAt: expect.any(Date) },
      where: { id: REQUEST, resolvedAt: null, teamId: TEAM },
    });
    expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    const arg = JSON.stringify(prisma.configAuditLog.create.mock.calls[0]?.[0]);
    expect(arg).toContain('TeamBudgetRequest');
    expect(arg).toContain('UPDATE');
    expect(arg).toContain(REQUEST);
    expect(arg).toContain('"resolvedAt":null');
  });

  it('lets an ORG_ADMIN who is not on the team dismiss', async () => {
    const { app } = await seeded({ orgRole: 'ADMIN' });
    expect((await dismiss(app)).statusCode).toBe(200);
  });

  it('answers 404 BUDGET_REQUEST_NOT_FOUND for an unknown, foreign or resolved request', async () => {
    const { app, prisma, rows } = await seeded({ teamRole: 'ADMIN' });
    const unknown = await dismiss(app, '00000000-0000-4000-8000-0000000000ff');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('BUDGET_REQUEST_NOT_FOUND');
    // The id exists but belongs to another team: the where clause names this team, so no match.
    const foreign = build({ teamRole: 'ADMIN' });
    foreign.updateMany.mockResolvedValueOnce({ count: 0 });
    await foreign.app.ready();
    expect((await dismiss(foreign.app)).json().error.code).toBe('BUDGET_REQUEST_NOT_FOUND');
    // Already resolved.
    expect((await dismiss(app)).statusCode).toBe(200);
    const again = await dismiss(app);
    expect(again.statusCode).toBe(404);
    expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a team LEAD without budget management and writes nothing', async () => {
    const { app, prisma, updateMany } = await seeded({ teamRole: 'LEAD' });
    const res = await dismiss(app);
    expect(res.statusCode).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
    expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('404s a caller with no standing on the team and rejects a non-uuid id', async () => {
    const { app } = await seeded({ teamRole: null });
    expect((await dismiss(app)).statusCode).toBe(404);
    expect((await dismiss(app, 'nope')).statusCode).toBe(400);
  });
});

describe('GET /teams/:id/budget-requests/mine', () => {
  const mine = (app: ReturnType<typeof build>['app']) =>
    app.inject({ method: 'GET', url: `${PREFIX}/${TEAM}/budget-requests/mine` });

  it('returns the pending request to a team LEAD, with no amount', async () => {
    const built = build({ teamRole: 'LEAD' });
    built.rows.push({
      createdAt: CREATED_AT,
      id: '00000000-0000-4000-8000-0000000000b2',
      reason: 'more please',
      requestedBy: { id: USER, name: 'Ada' },
      resolvedAt: null,
    });
    await built.app.ready();
    const res = await mine(built.app);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      createdAt: CREATED_AT.toISOString(),
      id: '00000000-0000-4000-8000-0000000000b2',
      reason: 'more please',
      requestedBy: { id: USER, name: 'Ada' },
    });
    expect(res.body).not.toMatch(/cents|usd/i);
    expect(built.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { resolvedAt: null, teamId: TEAM },
    });
  });

  it('returns null when nothing is pending', async () => {
    const { app } = build({ teamRole: 'LEAD' });
    await app.ready();
    expect((await mine(app)).json().data).toBeNull();
  });

  it('refuses a team MEMBER', async () => {
    const { app, findFirst } = build({ teamRole: 'MEMBER' });
    await app.ready();
    expect((await mine(app)).statusCode).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /teams/:id/budget-requests/:requestId/cancel', () => {
  const REQUEST = '00000000-0000-4000-8000-0000000000b2';
  const cancel = (app: ReturnType<typeof build>['app'], id = REQUEST) =>
    app.inject({ method: 'POST', url: `${PREFIX}/${TEAM}/budget-requests/${id}/cancel` });

  async function seeded(opts: Opts, requester = USER) {
    const built = build(opts);
    built.rows.push({
      createdAt: CREATED_AT,
      id: REQUEST,
      reason: 'more please',
      requestedBy: { id: requester, name: null },
      resolvedAt: null,
    });
    await built.app.ready();
    return built;
  }

  it('lets the requesting LEAD withdraw their request and audits it', async () => {
    const { app, prisma, rows, updateMany } = await seeded({ teamRole: 'LEAD' });
    const res = await cancel(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id: REQUEST });
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: REQUEST, requestedById: USER, resolvedAt: null, teamId: TEAM },
    });
    expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(prisma.configAuditLog.create).toHaveBeenCalledTimes(1);
    const arg = JSON.stringify(prisma.configAuditLog.create.mock.calls[0]?.[0]);
    expect(arg).toContain('TeamBudgetRequest');
    expect(arg).toContain('"cancelled":true');
  });

  it('does not let a LEAD withdraw a colleague’s request', async () => {
    const { app, prisma, rows } = await seeded(
      { teamRole: 'LEAD' },
      '00000000-0000-4000-8000-0000000000cc'
    );
    const res = await cancel(app);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BUDGET_REQUEST_NOT_FOUND');
    expect(rows[0]?.resolvedAt).toBeNull();
    expect(prisma.configAuditLog.create).not.toHaveBeenCalled();
  });

  it('lets a team ADMIN cancel anyone’s request', async () => {
    const { app } = await seeded({ teamRole: 'ADMIN' }, '00000000-0000-4000-8000-0000000000cc');
    expect((await cancel(app)).statusCode).toBe(200);
  });

  it('refuses a team MEMBER and 404s a caller with no standing', async () => {
    const member = await seeded({ teamRole: 'MEMBER' });
    expect((await cancel(member.app)).statusCode).toBe(403);
    expect(member.updateMany).not.toHaveBeenCalled();
    const none = await seeded({ teamRole: null });
    expect((await cancel(none.app)).statusCode).toBe(404);
  });
});
