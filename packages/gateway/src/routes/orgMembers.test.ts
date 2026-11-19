import { afterEach, describe, expect, it, vi } from 'vitest';

// The invite handler lazy-imports betterAuth.ts to send the magic link; the
// real module needs DATABASE_URL and BETTER_AUTH_SECRET at import.
const signInMagicLink = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/betterAuth.js', () => ({
  getAuth: () => ({ api: { signInMagicLink } }),
}));

import { makeAuthedApp } from '../test/authedApp.js';
import { orgMembersRoutes } from './orgMembers.js';
import { teamRoutes } from './teams.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PREFIX = '/api/v1/admin/organizations';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TARGET_USER = '00000000-0000-4000-8000-0000000000bb';
const TEAM_ID = '00000000-0000-4000-8000-0000000000cc';

const orgLockCalls: string[] = [];
/** Every lock the removal takes, in order: 'org', then 'team:<id>'. */
const lockOrder: string[] = [];
const teamMembershipDelete = vi.fn().mockResolvedValue({});
/** The target's team memberships in the organization, and the other members of those teams. */
const cascade: {
  peers: Array<{ role: string; teamId: string; userId: string }>;
  rows: Array<{ id: string; role: string; teamId: string; userId: string }>;
} = { peers: [], rows: [] };

const MEMBER_ROW = {
  createdAt: new Date(),
  id: 'row-1',
  orgId: ORG_ID,
  role: 'ADMIN',
  user: { email: 'lead@test.com', id: TARGET_USER, name: null, role: 'USER' },
  userId: TARGET_USER,
};

const auditCreate = vi.fn().mockResolvedValue({});
const userCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  email: data.email,
  id: TARGET_USER,
  isActive: data.isActive,
  role: data.role,
}));

const orgFindUnique = vi.fn();
const userFindFirst = vi.fn();
const teamFindUnique = vi.fn();
const teamMemberCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: 'team-member',
  ...data,
}));

function buildApp(
  role: string,
  membershipRole: string | null = 'ADMIN',
  trustedInvites = false,
  orgActive = true,
  teamRole = 'LEAD'
) {
  orgFindUnique.mockResolvedValue({ isActive: orgActive, trustedInvites });
  userFindFirst.mockResolvedValue(null);
  teamFindUnique.mockResolvedValue({ id: TEAM_ID, orgId: ORG_ID });
  let prisma: Record<string, unknown>;
  prisma = {
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => {
      lockOrder.push(`team:${id}`);
      return 1;
    }),
    $queryRaw: vi.fn(async () => {
      lockOrder.push('org');
      orgLockCalls.push(ORG_ID);
      return [{ id: ORG_ID }];
    }),
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
    configAuditLog: { create: auditCreate },
    organization: { findUnique: orgFindUnique },
    organizationMembership: {
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue(MEMBER_ROW),
      delete: vi.fn().mockResolvedValue({}),
      // The permissions loader reads the caller's own membership (`where.userId`); the member list
      // reads the rows with their users; the last-admin guard reads every role in the org.
      findMany: vi
        .fn()
        .mockImplementation((args: { include?: unknown; where: { userId?: string } }) => {
          if (args.where.userId) {
            return Promise.resolve(membershipRole ? [{ orgId: ORG_ID, role: membershipRole }] : []);
          }
          return Promise.resolve(
            args.include ? [MEMBER_ROW] : [{ role: 'ADMIN' }, { role: 'ADMIN' }]
          );
        }),
      findUnique: vi
        .fn()
        .mockImplementation(({ where }: { where: { userId_orgId?: unknown; id?: string } }) => {
          if (where.id) {
            return Promise.resolve(MEMBER_ROW);
          }
          return Promise.resolve(membershipRole ? { id: 'row-1', role: membershipRole } : null);
        }),
      update: vi.fn().mockResolvedValue({ ...MEMBER_ROW, role: 'MEMBER' }),
    },
    team: {
      findMany: vi.fn().mockImplementation(async () => {
        const team = await teamFindUnique();
        return team ? [{ id: team.id, isActive: team.isActive ?? true, orgId: team.orgId }] : [];
      }),
      findUnique: teamFindUnique,
    },
    teamMembership: {
      create: teamMemberCreate,
      delete: teamMembershipDelete,
      findMany: vi
        .fn()
        .mockImplementation(
          (args: {
            select: { id?: unknown; team?: unknown };
            where: { team?: { orgId?: string }; teamId?: unknown; userId?: string };
          }) => {
            if (args.where.team?.orgId) {
              // The organization-removal cascade's reads of the target's memberships.
              return Promise.resolve(
                'id' in args.select ? cascade.rows : cascade.rows.map((r) => ({ teamId: r.teamId }))
              );
            }
            if (args.where.teamId && !args.where.userId) {
              return Promise.resolve(cascade.peers);
            }
            return Promise.resolve(
              args.select.team
                ? [{ role: teamRole, team: { id: TEAM_ID, isActive: true, orgId: ORG_ID } }]
                : [{ role: teamRole, teamId: TEAM_ID }]
            );
          }
        ),
      findUnique: vi.fn().mockResolvedValue({ role: teamRole }),
    },
    user: { create: userCreate, findFirst: userFindFirst },
  };
  const app = makeAuthedApp({ prisma, role, sub: USER_ID });
  // Register under the real prefix so a plugin that drops it is caught here.
  app.register(orgMembersRoutes, { prefix: PREFIX });
  app.register(teamRoutes, { prefix: '/api/v1/teams' });
  return app;
}

describe('GET /:orgId/members', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('returns members list for org admin', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/members` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].userId).toBe(TARGET_USER);
  });

  it('returns 403 when non-member tries to list', async () => {
    const app = buildApp('USER', null);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/${ORG_ID}/members` });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /:orgId/members', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('creates a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBeOneOf([200, 201]);
    // The standard `{ data }` envelope, not a bare row.
    expect(JSON.parse(res.body).data.id).toBe('row-1');
    expect(orgLockCalls).toEqual([ORG_ID]);
    // Upstream's audit assertion: the entry is written with the locked change.
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        entityId: 'row-1',
        entityType: 'OrganizationMembership',
      }),
    });
  });

  it('allows an org ADMIN who is only a platform USER to manage members', async () => {
    const app = buildApp('USER', 'ADMIN');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBeOneOf([200, 201]);
  });

  it('returns 403 for a platform USER who is only an org MEMBER', async () => {
    const app = buildApp('USER', 'MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'MEMBER', userId: TARGET_USER }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /:orgId/members/invite', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  const invite = async (role: string, trustedInvites = false, orgActive = true) => {
    const app = buildApp(role, 'ADMIN', trustedInvites, orgActive);
    await app.ready();
    return app.inject({
      body: JSON.stringify({ email: 'New@Example.com' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
  };

  it.each([undefined, 'LEAD', 'ADMIN'] as const)(
    'invites into an organization team with role %s',
    async (teamRole) => {
      const app = buildApp('USER');
      const res = await app.inject({
        method: 'POST',
        payload: { email: 'team@example.com', teamId: TEAM_ID, ...(teamRole ? { teamRole } : {}) },
        url: `${PREFIX}/${ORG_ID}/members/invite`,
      });
      expect(res.statusCode).toBe(201);
      expect(teamMemberCreate).toHaveBeenCalledWith({
        data: { role: teamRole ?? 'MEMBER', teamId: TEAM_ID, userId: TARGET_USER },
      });
      expect(auditCreate.mock.calls.map((c) => c[0].data.entityType)).toEqual([
        'OrganizationMembership',
        'TeamMembership',
        'User',
      ]);
      // The ground of the decision that allowed the invitation is on every row it wrote.
      expect(
        auditCreate.mock.calls.map((c) => (c[0].data.context as { authority?: string })?.authority)
      ).toEqual(['org-admin', 'org-admin', 'org-admin']);
      await app.close();
    }
  );

  it('rejects a team from another organization without creating the user', async () => {
    const app = buildApp('USER');
    teamFindUnique.mockResolvedValue({ id: TEAM_ID, orgId: TARGET_USER });
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'team@example.com', teamId: TEAM_ID },
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TEAM_ORG_MISMATCH');
    expect(userCreate).not.toHaveBeenCalled();
    expect(signInMagicLink).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers a team that does not exist as a mismatch, before asking about it', async () => {
    const app = buildApp('USER');
    teamFindUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'team@example.com', teamId: TEAM_ID },
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TEAM_ORG_MISMATCH');
    expect(userCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('writes the team decision authority on the TeamMembership row', async () => {
    // A platform admin with no organization membership who holds LEAD on the team (the harness's
    // membership): the organization decision is `platform-admin`, the team decision `team-role`.
    const app = buildApp('ADMIN', null);
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'team@example.com', teamId: TEAM_ID },
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(201);
    const teamRow = auditCreate.mock.calls
      .map((c) => c[0].data as { entityType: string; context?: Record<string, unknown> })
      .find((d) => d.entityType === 'TeamMembership');
    expect(teamRow?.context).toMatchObject({ authority: 'team-role' });
    const orgRow = auditCreate.mock.calls
      .map((c) => c[0].data as { entityType: string; context?: Record<string, unknown> })
      .find((d) => d.entityType === 'OrganizationMembership');
    expect(orgRow?.context).toMatchObject({ authority: 'platform-admin' });
    expect(teamRow?.context?.requestId).toEqual(expect.any(String));
    await app.close();
  });

  it("leaves an org admin's invitee waiting for a platform admin's approval", async () => {
    const res = await invite('USER');

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data).toMatchObject({ isActive: false, orgRole: 'MEMBER' });
    const call = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const { data } = call;
    // Inactive and unapproved is the approval queue; the address is verified
    // by the invitee following the link, not vouched for by the inviter.
    expect(data).toEqual({
      email: 'new@example.com',
      emailVerified: false,
      isActive: false,
      role: 'USER',
    });
    // The org membership and the magic link still go out.
    expect(orgLockCalls).toEqual([ORG_ID]);
    expect(signInMagicLink).toHaveBeenCalledTimes(1);
  });

  it("approves a platform admin's invitee at once", async () => {
    const res = await invite('ADMIN');

    expect(res.statusCode).toBe(201);
    const call = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const { data } = call;
    expect(data).toMatchObject({
      approvalSource: 'admin',
      approvedAt: expect.any(Date),
      emailVerified: true,
      isActive: true,
    });
    // A platform admin's invite needs no trust lookup.
    expect(orgFindUnique).not.toHaveBeenCalled();
  });

  it("approves a trusted organization's org-admin invitee as org_admin", async () => {
    const res = await invite('USER', true);

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data).toMatchObject({ isActive: true, orgRole: 'MEMBER' });
    const call = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({
      approvalSource: 'org_admin',
      approvedAt: expect.any(Date),
      emailVerified: true,
      isActive: true,
    });
    expect(orgFindUnique).toHaveBeenCalledWith({
      select: { isActive: true, trustedInvites: true },
      where: { id: ORG_ID },
    });
    // The approval is audited, not only the membership.
    const entityTypes = auditCreate.mock.calls.map(
      (c) => (c[0] as { data: { entityType: string } }).data.entityType
    );
    expect(entityTypes).toEqual(['OrganizationMembership', 'User']);
  });

  it('queues the invitee of a trusted but deactivated organization', async () => {
    await invite('USER', true, false);

    const call = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ emailVerified: false, isActive: false });
    expect(call.data).not.toHaveProperty('approvalSource');
  });

  it('keeps the platform admin source in a trusted organization', async () => {
    await invite('ADMIN', true);

    const call = userCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ approvalSource: 'admin' });
  });
});

describe('POST /:orgId/members/invite authorization', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('refuses an organization member who is not an administrator', async () => {
    const app = buildApp('USER', 'MEMBER');
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'team@example.com' },
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.missing).toBe('org.members.manage');
    expect(userCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('asks team.members.manage on the team an invitation names', async () => {
    const app = buildApp('USER');
    // A deactivated team confers nothing on an organization administrator.
    teamFindUnique.mockResolvedValue({ id: TEAM_ID, isActive: false, orgId: ORG_ID });
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'team@example.com', teamId: TEAM_ID },
      url: `${PREFIX}/${ORG_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.missing).toBe('team.members.manage');
    expect(userCreate).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /teams/:id/members/invite', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it.each([
    ['USER', 'LEAD', true, true, true, 'team_lead'],
    ['USER', 'LEAD', false, true, false, null],
    ['USER', 'LEAD', true, false, false, null],
    ['ADMIN', 'LEAD', false, false, true, 'admin'],
    ['USER', 'ADMIN', true, true, true, 'team_lead'],
  ] as const)(
    'applies approval policy for %s/%s, trust %s, active %s',
    async (role, teamRole, trusted, active, approved, source) => {
      const app = buildApp(role, null, trusted, active, teamRole);
      const res = await app.inject({
        method: 'POST',
        payload: { email: ' New@Example.com ' },
        url: `/api/v1/teams/${TEAM_ID}/members/invite`,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({ isActive: approved, teamRole: 'MEMBER' });
      expect(userCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'new@example.com',
            emailVerified: approved,
            isActive: approved,
            role: 'USER',
          }),
        })
      );
      const data = userCreate.mock.calls[0]?.[0].data;
      if (source) {
        expect(data).toMatchObject({ approvalSource: source, approvedAt: expect.any(Date) });
      } else {
        expect(data).not.toHaveProperty('approvalSource');
      }
      expect(teamMemberCreate).toHaveBeenCalledWith({
        data: { role: 'MEMBER', teamId: TEAM_ID, userId: TARGET_USER },
      });
      expect(auditCreate.mock.calls.map((c) => c[0].data.entityType)).toEqual([
        'OrganizationMembership',
        'TeamMembership',
        'User',
      ]);
      expect(orgLockCalls).toEqual([ORG_ID]);
      expect(signInMagicLink).toHaveBeenCalledTimes(1);
      await app.close();
    }
  );

  it.each([
    ['USER', 'MEMBER', 'MEMBER', 'FORBIDDEN'],
    ['USER', 'LEAD', 'ADMIN', 'PRIVILEGE_ESCALATION'],
  ])('rejects invitation by %s/%s granting %s', async (platformRole, teamRole, role, code) => {
    const app = buildApp(platformRole, null, false, true, teamRole);
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'new@example.com', role },
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe(code);
    expect(userCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses an existing email', async () => {
    const app = buildApp('USER');
    userFindFirst.mockResolvedValue({ id: TARGET_USER });
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'existing@example.com' },
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USER_EXISTS');
    expect(userCreate).not.toHaveBeenCalled();
    expect(teamMemberCreate).not.toHaveBeenCalled();
    expect(signInMagicLink).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an empty invitation', async () => {
    const app = buildApp('USER');
    const res = await app.inject({
      method: 'POST',
      payload: {},
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(400);
    expect(userCreate).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps a concurrent email insertion to USER_EXISTS', async () => {
    const app = buildApp('USER');
    userCreate.mockRejectedValueOnce(Object.assign(new Error('unique email'), { code: 'P2002' }));
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'existing@example.com' },
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USER_EXISTS');
    expect(signInMagicLink).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not send the link when the membership audit fails', async () => {
    const app = buildApp('USER');
    auditCreate.mockRejectedValueOnce(new Error('audit failed'));
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'new@example.com' },
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(500);
    expect(signInMagicLink).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the created account when email delivery fails', async () => {
    const app = buildApp('USER');
    signInMagicLink.mockRejectedValueOnce(new Error('mail offline'));
    const res = await app.inject({
      method: 'POST',
      payload: { email: 'new@example.com', role: 'LEAD' },
      url: `/api/v1/teams/${TEAM_ID}/members/invite`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.teamRole).toBe('LEAD');
    await app.close();
  });
});

describe('PATCH /:orgId/members/:userId guards', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('refuses an administrator removing themselves', async () => {
    const app = buildApp('USER');
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${USER_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SELF_REMOVAL');
    await app.close();
  });
});

describe('PATCH /:orgId/members/:userId', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('returns 403 for a platform-USER who is only an org MEMBER', async () => {
    const app = buildApp('USER', 'MEMBER');
    await app.ready();
    const res = await app.inject({
      body: JSON.stringify({ role: 'ADMIN' }),
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /:orgId/members/:userId', () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgLockCalls.length = 0;
    lockOrder.length = 0;
    cascade.rows = [];
    cascade.peers = [];
  });

  it('removes a membership', async () => {
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(204);
    expect(orgLockCalls).toEqual([ORG_ID]);
  });

  it('removes the memberships in every team of the organization in the same transaction, locking the organization first and the teams in ascending id order', async () => {
    cascade.rows = [
      { id: 'tm-b', role: 'MEMBER', teamId: 'team-b', userId: TARGET_USER },
      { id: 'tm-a', role: 'ADMIN', teamId: 'team-a', userId: TARGET_USER },
    ];
    // Team A keeps no other ADMIN: an organization authority may leave it so.
    cascade.peers = [{ role: 'MEMBER', teamId: 'team-a', userId: 'someone' }];
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(204);
    expect(lockOrder).toEqual(['org', 'team:team-a', 'team:team-b']);
    expect(teamMembershipDelete.mock.calls.map((c) => c[0].where.id).sort()).toEqual([
      'tm-a',
      'tm-b',
    ]);
    const audited = auditCreate.mock.calls
      .map((c) => c[0].data)
      .filter((d: { entityType: string }) => d.entityType === 'TeamMembership');
    expect(audited.map((d: { entityId: string }) => d.entityId).sort()).toEqual(['tm-a', 'tm-b']);
    expect(audited.every((d: { action: string }) => d.action === 'DELETE')).toBe(true);
  });

  it('removes no team membership when the user has none in the organization', async () => {
    cascade.rows = [];
    const app = buildApp('ADMIN');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(204);
    expect(teamMembershipDelete).not.toHaveBeenCalled();
    expect(lockOrder).toEqual(['org']);
  });

  it('returns 403 for a platform-USER who is only an org MEMBER', async () => {
    const app = buildApp('USER', 'MEMBER');
    await app.ready();
    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/${ORG_ID}/members/${TARGET_USER}`,
    });
    expect(res.statusCode).toBe(403);
  });
});
