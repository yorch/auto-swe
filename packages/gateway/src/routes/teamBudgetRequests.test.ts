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
  teamRole?: 'ADMIN' | 'LEAD' | 'ENGINEER' | null;
  orgRole?: 'ORG_ADMIN' | 'ORG_MEMBER' | null;
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
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    organizationMembership: {
      findUnique: vi.fn(async () => (opts.orgRole ? { role: opts.orgRole } : null)),
    },
    team: {
      findUnique: vi.fn(async () => ({
        budgetAlertThresholdPercent: null,
        id: TEAM,
        memberships: opts.teamRole ? [{ role: opts.teamRole }] : [],
        monthlyBudgetUsdCents: null,
        name: 'Payments',
        orgId: ORG,
      })),
    },
    teamBudgetRequest: { create, findMany },
    teamMembership: {
      findUnique: vi.fn(async () => (opts.teamRole ? { role: opts.teamRole } : null)),
    },
  };
  const app = makeAuthedApp({ prisma, role: opts.platformRole ?? 'ENGINEER', sub: USER });
  app.register(teamBudgetRequestRoutes, { prefix: PREFIX });
  return { app, create, findMany, prisma, rows };
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
    const { app, create } = build({ teamRole: 'ENGINEER' });
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
    const { app } = await seeded({ orgRole: 'ORG_ADMIN' });
    expect((await list(app)).statusCode).toBe(200);
  });

  it('refuses a team LEAD', async () => {
    const { app } = await seeded({ teamRole: 'LEAD' });
    const res = await list(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });
});
