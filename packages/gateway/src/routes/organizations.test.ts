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
