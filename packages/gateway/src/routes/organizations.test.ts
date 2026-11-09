import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthedApp } from '../test/authedApp.js';
import { organizationRoutes } from './organizations.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PREFIX = '/api/v1/admin/organizations';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

const ORG_ROW = { id: ORG_ID, name: 'Test Org', slug: 'test-org', trustedInvites: false };

const orgUpdate = vi.fn();
const auditCreate = vi.fn().mockResolvedValue({});

function buildApp(role: string, membershipRole: string | null = 'ORG_ADMIN') {
  orgUpdate.mockResolvedValue({ ...ORG_ROW, trustedInvites: true });
  const app = makeAuthedApp({
    prisma: {
      configAuditLog: { create: auditCreate },
      organization: { findUnique: vi.fn().mockResolvedValue(ORG_ROW), update: orgUpdate },
      organizationMembership: {
        findUnique: vi.fn().mockResolvedValue(membershipRole ? { role: membershipRole } : null),
      },
    },
    role,
    sub: USER_ID,
  });
  // Register under the real prefix so a plugin that drops it is caught here.
  app.register(organizationRoutes, { prefix: PREFIX });
  return app;
}

async function patch(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  await app.ready();
  return app.inject({
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
    url: `${PREFIX}/${ORG_ID}`,
  });
}

describe('PATCH /:orgId trustedInvites', () => {
  afterEach(() => vi.clearAllMocks());

  it('lets a platform ADMIN trust an organization and audits the change', async () => {
    const res = await patch(buildApp('ADMIN', null), { trustedInvites: true });

    expect(res.statusCode).toBe(200);
    expect(orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { trustedInvites: true } })
    );
    const audit = auditCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(JSON.stringify(audit.data)).toContain('trustedInvites');
  });

  it('refuses an ORG_ADMIN trusting its own organization', async () => {
    const res = await patch(buildApp('ENGINEER', 'ORG_ADMIN'), { trustedInvites: true });

    expect(res.statusCode).toBe(403);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses an ORG_ADMIN clearing trust, even alongside other fields', async () => {
    const res = await patch(buildApp('ENGINEER', 'ORG_ADMIN'), {
      name: 'Renamed',
      trustedInvites: false,
    });

    expect(res.statusCode).toBe(403);
    expect(orgUpdate).not.toHaveBeenCalled();
  });

  it('still lets an ORG_ADMIN rename the organization', async () => {
    const res = await patch(buildApp('ENGINEER', 'ORG_ADMIN'), { name: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(orgUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Renamed' } }));
  });
});

describe('organization budget dollars', () => {
  afterEach(() => vi.clearAllMocks());

  const BUDGETED = {
    ...ORG_ROW,
    budgetAlertThresholdPercent: 80,
    monthlyBudgetUsdCents: 12345,
  };

  function budgetedApp(role: string, membershipRole: string, platformRole = role) {
    const app = makeAuthedApp({
      prisma: {
        organization: { findUnique: vi.fn().mockResolvedValue(BUDGETED) },
        organizationMembership: {
          findMany: vi.fn().mockResolvedValue([
            {
              organization: {
                ...BUDGETED,
                monthlyUsages: [{ costUsdAccrued: '50', runsCompleted: 3, yearMonth: '2026-06' }],
              },
              role: membershipRole,
            },
          ]),
          findUnique: vi.fn().mockResolvedValue({ role: membershipRole }),
        },
      },
      role: platformRole,
      sub: USER_ID,
    });
    app.register(organizationRoutes, { prefix: PREFIX });
    return app;
  }

  it('GET /:orgId omits the cap for a plain ORG_MEMBER', async () => {
    const app = budgetedApp('ENGINEER', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).not.toHaveProperty('monthlyBudgetUsdCents');
    expect(res.body).not.toContain('12345');
  });

  it('GET /:orgId keeps the cap for an ORG_ADMIN', async () => {
    const app = budgetedApp('ENGINEER', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}` });
    expect(JSON.parse(res.body).data.monthlyBudgetUsdCents).toBe(12345);
  });

  it('GET / drops the cap and the spend from a row the caller is only a member of', async () => {
    const app = budgetedApp('LEAD', 'ORG_MEMBER');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: PREFIX });
    const [row] = JSON.parse(res.body).data;
    expect(row).not.toHaveProperty('monthlyBudgetUsdCents');
    expect(row).not.toHaveProperty('currentMonthUsage');
    expect(row).toMatchObject({ role: 'ORG_MEMBER', slug: 'test-org' });
    // 50 / 123.45 = 40.5021...% is rounded to one decimal; nothing else carries the cap.
    expect(row.alert.percent).toBe(40.5);
    expect(JSON.stringify(row)).not.toContain('12345');
    expect(JSON.stringify(row)).not.toContain('40.50');
  });

  it('GET / keeps both for an ORG_ADMIN row', async () => {
    const app = budgetedApp('LEAD', 'ORG_ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: PREFIX });
    const [row] = JSON.parse(res.body).data;
    expect(row.monthlyBudgetUsdCents).toBe(12345);
    expect(row.currentMonthUsage.costUsdAccrued).toBe(50);
  });
});
