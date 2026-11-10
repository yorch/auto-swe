import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthedApp } from '../test/authedApp.js';
import { teamBudgetRoutes } from './teamBudget.js';

// Team and org spend come from the hand-built Prisma mock (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

const TEAM = '00000000-0000-4000-8000-000000000011';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-0000000000aa';
const PREFIX = '/api/v1/teams';

interface Opts {
  platformRole?: string;
  /** The caller's team role; null for a non-member. */
  teamRole?: 'ADMIN' | 'LEAD' | 'ENGINEER' | null;
  orgRole?: 'ORG_ADMIN' | 'ORG_MEMBER' | null;
  /** Which organization the caller's `orgRole` is held in; the team's own by default. */
  orgRoleIn?: typeof ORG | typeof OTHER_ORG;
  teamCap?: number | null;
  orgCap?: number | null;
  teamSpentUsd?: number;
  orgSpentUsd?: number;
  unknownTeam?: boolean;
}

function build(opts: Opts = {}) {
  const teamCap = opts.teamCap ?? null;
  const row = {
    budgetAlertThresholdPercent: null,
    id: TEAM,
    memberships: opts.teamRole ? [{ role: opts.teamRole }] : [],
    monthlyBudgetUsdCents: teamCap,
    name: 'Payments',
    orgId: ORG,
  };
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    budgetAlertThresholdPercent: null,
    id: TEAM,
    monthlyBudgetUsdCents: teamCap,
    ...data,
  }));
  const prisma = {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    organization: {
      findMany: vi.fn(async () => [
        { budgetAlertThresholdPercent: null, id: ORG, monthlyBudgetUsdCents: opts.orgCap ?? null },
      ]),
    },
    organizationMembership: {
      // Keyed by the organization asked about, so a role held in another one does not answer.
      findUnique: vi.fn(async ({ where }: { where: { userId_orgId: { orgId: string } } }) =>
        opts.orgRole && where.userId_orgId.orgId === (opts.orgRoleIn ?? ORG)
          ? { role: opts.orgRole }
          : null
      ),
    },
    orgMonthlyUsage: {
      findUnique: vi.fn(async () => ({ costUsdAccrued: opts.orgSpentUsd ?? 0 })),
    },
    team: {
      findMany: vi.fn(async () => [
        { budgetAlertThresholdPercent: null, id: TEAM, monthlyBudgetUsdCents: teamCap },
      ]),
      findUnique: vi.fn(async () => (opts.unknownTeam ? null : row)),
      update,
    },
    teamSpendUsd: { [TEAM]: opts.teamSpentUsd ?? 0 },
  };
  const app = makeAuthedApp({ prisma, role: opts.platformRole ?? 'ENGINEER', sub: USER });
  app.register(teamBudgetRoutes, { prefix: PREFIX });
  return { app, prisma, update };
}

afterEach(() => vi.clearAllMocks());

const get = (app: ReturnType<typeof build>['app'], path: string) =>
  app.inject({ method: 'GET', url: `${PREFIX}/${TEAM}${path}` });
const patch = (app: ReturnType<typeof build>['app'], body: unknown) =>
  app.inject({ method: 'PATCH', payload: body as object, url: `${PREFIX}/${TEAM}/budget` });

describe('GET /teams/:id/budget', () => {
  it('returns the cap, threshold and month spend to a team ADMIN', async () => {
    const { app } = build({ teamCap: 5000, teamRole: 'ADMIN', teamSpentUsd: 12.34 });
    await app.ready();
    const res = await get(app, '/budget');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      budgetAlertThresholdPercent: null,
      monthlyBudgetUsdCents: 5000,
      monthSpendUsdCents: 1234,
    });
  });

  it.each([
    ['an ORG_ADMIN who is not on the team', { orgRole: 'ORG_ADMIN' as const }],
    ['a platform ADMIN who is not on the team', { platformRole: 'ADMIN' }],
  ])('lets %s read it', async (_name, opts) => {
    const { app } = build(opts);
    await app.ready();
    expect((await get(app, '/budget')).statusCode).toBe(200);
  });

  it('lets an ORG_ADMIN of the same organization read it, and 404s one of another organization', async () => {
    const same = build({ orgRole: 'ORG_ADMIN', teamCap: 5000 });
    await same.app.ready();
    const ok = await get(same.app, '/budget');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ monthlyBudgetUsdCents: 5000 });

    // An ORG_ADMIN elsewhere has no standing here: the 404 an unknown team gets, no dollars.
    const other = build({ orgRole: 'ORG_ADMIN', orgRoleIn: OTHER_ORG, teamCap: 5000 });
    await other.app.ready();
    const refused = await get(other.app, '/budget');
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('5000');
  });

  it('refuses an ORG_MEMBER of the same organization who is not on the team', async () => {
    const { app } = build({ orgRole: 'ORG_MEMBER', teamCap: 5000 });
    await app.ready();
    expect((await get(app, '/budget')).statusCode).toBe(404);
  });

  it('refuses a team LEAD and a platform LEAD who is only a team engineer', async () => {
    for (const opts of [
      { teamRole: 'LEAD' as const },
      { platformRole: 'LEAD', teamRole: 'ENGINEER' as const },
    ]) {
      const { app } = build({ teamCap: 5000, ...opts });
      await app.ready();
      const res = await get(app, '/budget');
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('5000');
    }
  });

  it('answers a non-member, a platform LEAD and an unknown team with the same 404', async () => {
    const answers = [];
    for (const opts of [
      { teamRole: null },
      { orgRole: 'ORG_MEMBER' as const, platformRole: 'LEAD', teamRole: null },
      { unknownTeam: true },
    ]) {
      const { app } = build(opts);
      await app.ready();
      const res = await get(app, '/budget');
      answers.push([res.statusCode, res.body]);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
  });
});

describe('PATCH /teams/:id/budget', () => {
  it('sets the cap, audits it and answers with the settings', async () => {
    const { app, prisma, update } = build({ teamRole: 'ADMIN' });
    await app.ready();
    const res = await patch(app, { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 2500 });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { budgetAlertThresholdPercent: 80, monthlyBudgetUsdCents: 2500 },
        where: { id: TEAM },
      })
    );
    expect(res.json().data).toMatchObject({ monthlyBudgetUsdCents: 2500 });
    expect(prisma.configAuditLog.create).toHaveBeenCalled();
  });

  it('clears with null and leaves an omitted key alone', async () => {
    const { app, update } = build({ orgRole: 'ORG_ADMIN', teamCap: 100 });
    await app.ready();
    await patch(app, { monthlyBudgetUsdCents: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { monthlyBudgetUsdCents: null } })
    );
  });

  it('accepts a zero cap', async () => {
    const { app } = build({ teamRole: 'ADMIN' });
    await app.ready();
    expect((await patch(app, { monthlyBudgetUsdCents: 0 })).statusCode).toBe(200);
  });

  it.each([
    [{ monthlyBudgetUsdCents: -1 }],
    [{ monthlyBudgetUsdCents: 1.5 }],
    [{ monthlyBudgetUsdCents: 2_147_483_648 }],
    [{ budgetAlertThresholdPercent: 0 }],
    [{ budgetAlertThresholdPercent: 101 }],
  ])('rejects %j', async (body) => {
    const { app, update } = build({ teamRole: 'ADMIN' });
    await app.ready();
    expect((await patch(app, body)).statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets an ORG_ADMIN of the same organization write, and 404s one of another organization', async () => {
    const same = build({ orgRole: 'ORG_ADMIN' });
    await same.app.ready();
    expect((await patch(same.app, { monthlyBudgetUsdCents: 700 })).statusCode).toBe(200);
    expect(same.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { monthlyBudgetUsdCents: 700 }, where: { id: TEAM } })
    );

    const other = build({ orgRole: 'ORG_ADMIN', orgRoleIn: OTHER_ORG });
    await other.app.ready();
    expect((await patch(other.app, { monthlyBudgetUsdCents: 700 })).statusCode).toBe(404);
    expect(other.update).not.toHaveBeenCalled();
  });

  it('refuses a team LEAD, 404s a non-member, and never writes for either', async () => {
    const lead = build({ teamRole: 'LEAD' });
    await lead.app.ready();
    expect((await patch(lead.app, { monthlyBudgetUsdCents: 1 })).statusCode).toBe(403);
    const out = build({ teamRole: null });
    await out.app.ready();
    expect((await patch(out.app, { monthlyBudgetUsdCents: 1 })).statusCode).toBe(404);
    expect(lead.update).not.toHaveBeenCalled();
    expect(out.update).not.toHaveBeenCalled();
  });
});

describe('GET /teams/:id/budget/status', () => {
  it('shows the TEAM scope when the team cap is the tighter, with no dollars', async () => {
    const { app } = build({
      orgCap: 1_000_000,
      orgSpentUsd: 100,
      teamCap: 10_000,
      teamRole: 'ENGINEER',
      teamSpentUsd: 50,
    });
    await app.ready();
    const res = await get(app, '/budget/status');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      percentUsed: 50,
      scope: 'team',
      state: expect.any(String),
    });
    expect(res.body).not.toMatch(/10000|1000000|monthSpend|Cents/);
  });

  it('shows the ORG scope when the org cap is the tighter', async () => {
    const { app } = build({
      orgCap: 10_000,
      orgSpentUsd: 90,
      teamCap: 100_000,
      teamRole: 'ENGINEER',
      teamSpentUsd: 10,
    });
    await app.ready();
    expect((await get(app, '/budget/status')).json().data).toMatchObject({
      percentUsed: 90,
      scope: 'org',
    });
  });

  it('is no_cap when neither is set, and 404s a non-member', async () => {
    const { app } = build({ teamRole: 'ENGINEER' });
    await app.ready();
    expect((await get(app, '/budget/status')).json().data).toMatchObject({ state: 'no_cap' });
    const out = build({ teamRole: null });
    await out.app.ready();
    expect((await get(out.app, '/budget/status')).statusCode).toBe(404);
  });

  it('reads as over at a zero team cap', async () => {
    const { app } = build({ teamCap: 0, teamRole: 'ENGINEER' });
    await app.ready();
    expect((await get(app, '/budget/status')).json().data).toMatchObject({
      percentUsed: 100,
      scope: 'team',
      state: 'over',
    });
  });
});
