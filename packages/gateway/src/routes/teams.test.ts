import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgTeamRoutes, teamRoutes } from './teams.js';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => ['pypi.org']),
}));

/**
 * Tiny in-memory harness covering just the two endpoints these tests target:
 *   - DELETE /api/v1/teams/:id/members/:userId
 *   - PUT    /api/v1/teams/:id/shell-image-allowlist
 *
 * Both are gated behind `requireAuth({ requiredTeamRole: 'LEAD' })`,
 * so the harness has to provide:
 *   - a fake JWT verifier (state.userRole drives the payload),
 *   - team.findUnique (read for the allowlist endpoint + RBAC team lookup),
 *   - teamMembership.{findUnique, delete} (RBAC + the route's own DB ops).
 *
 * Platform ADMIN bypasses team-role checks (see auth.ts:328), so the test
 * relies on returning userRole='USER' + a matching teamMembership row.
 */
interface MembershipRow {
  id: string;
  userId: string;
  teamId: string;
  role: 'ADMIN' | 'LEAD' | 'MEMBER';
}

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  shellImageAllowlist: string[];
  egressAllowlist: string[];
  isActive?: boolean;
  orgId?: string;
  orgName?: string;
}

interface State {
  orgMemberships?: Array<{ id: string; userId: string; orgId: string; role: string }>;
  userRole: 'ADMIN' | 'USER';
  /** sub claim on the fake JWT — must match a membership row to pass team RBAC. */
  userId: string;
  teams: TeamRow[];
  memberships: MembershipRow[];
  orgAdminIds?: string[];
  /** Row locks taken on the team (`SELECT … FOR UPDATE`), in order. */
  locks?: string[];
  /** When true, `teamMembership.create` loses a concurrent race (P2002). */
  createConflict?: boolean;
  /** Rows `connectionTeamShare.findMany` returns, and the queries it was asked. */
  shares?: Array<{ connection: Record<string, unknown> }>;
  shareQueries?: Array<{ where: Record<string, unknown> }>;
  /** The `findMany` arguments `GET /teams` passed to prisma. */
  teamQueries?: Array<{ include: Record<string, unknown>; where: Record<string, unknown> }>;
  /** The `include` the team detail read passed to `team.findUnique`. */
  detailIncludes?: Array<Record<string, unknown>>;
  /** Rows written to the configuration audit log. */
  audits?: Array<{ action: string; entityType: string; [key: string]: unknown }>;
}

interface TeamClause {
  AND?: TeamClause[];
  OR?: TeamClause[];
  isActive?: boolean;
  memberships?: { some: { userId: string; role?: { in: string[] } } };
  organization?: unknown;
}

const TEAM_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_USER_ID = '00000000-0000-4000-8000-0000000000aa';
const TARGET_USER_ID = '00000000-0000-4000-8000-0000000000bb';

function freshState(overrides?: Partial<State>): State {
  return {
    memberships: [
      // The caller (LEAD in this team) — needed to pass requiredTeamRole
      {
        id: 'm-caller',
        role: 'LEAD',
        teamId: TEAM_ID,
        userId: ADMIN_USER_ID,
      },
      // The target member to remove
      {
        id: 'm-target',
        role: 'MEMBER',
        teamId: TEAM_ID,
        userId: TARGET_USER_ID,
      },
    ],
    orgMemberships: [
      { id: 'org-caller', orgId: TEAM_ID, role: 'ADMIN', userId: ADMIN_USER_ID },
      { id: 'org-target', orgId: TEAM_ID, role: 'MEMBER', userId: TARGET_USER_ID },
      { id: 'default-caller', orgId: 'org-default', role: 'MEMBER', userId: ADMIN_USER_ID },
    ],
    teams: [
      {
        egressAllowlist: [],
        id: TEAM_ID,
        name: 'platform',
        shellImageAllowlist: [],
        slug: 'platform',
      },
    ],
    userId: ADMIN_USER_ID,
    userRole: 'USER',
    ...overrides,
  };
}

function buildApp(state: State): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9_999_999_999,
      iat: 0,
      role: state.userRole,
      sub: state.userId,
    }),
  } as unknown as never);

  const prisma: Record<string, unknown> = {
    $executeRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      state.locks = [...(state.locks ?? []), String(values[0])];
      return 1;
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    configAuditLog: {
      create: async ({ data }: { data: { action: string; entityType: string } }) => {
        state.audits = [...(state.audits ?? []), data];
        return data;
      },
    },
    connectionTeamShare: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        state.shareQueries = [...(state.shareQueries ?? []), args];
        return state.shares ?? [];
      },
    },
    organization: {
      findUnique: async ({ where }: { where: { id?: string; slug?: string } }) =>
        // Single default org for the create-path test.
        where.slug === 'default' || where.id === 'org-default' || where.id === TEAM_ID
          ? { id: where.id ?? 'org-default', slug: 'default' }
          : null,
    },
    organizationMembership: {
      createMany: async ({ data }: { data: { userId: string; orgId: string; role: string } }) => {
        state.orgMemberships = [...(state.orgMemberships ?? []), { id: 'auto-org', ...data }];
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { orgId: { in: string[] }; userId: string } }) =>
        (state.orgMemberships ?? [])
          .filter((m) => m.userId === where.userId && where.orgId.in.includes(m.orgId))
          .map((m) => ({ orgId: m.orgId, role: m.role })),
      findUnique: async ({
        where,
      }: {
        where: { userId_orgId: { userId: string; orgId: string } };
      }) =>
        state.orgMemberships?.find(
          (m) => m.userId === where.userId_orgId.userId && m.orgId === where.userId_orgId.orgId
        ) ?? null,
      findUniqueOrThrow: async ({
        where,
      }: {
        where: { userId_orgId: { userId: string; orgId: string } };
      }) =>
        state.orgMemberships?.find(
          (m) => m.userId === where.userId_orgId.userId && m.orgId === where.userId_orgId.orgId
        ),
    },
    team: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (state.teams.some((team) => team.name === data.name || team.slug === data.slug)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        return { id: 'new-team', ...data };
      },
      findFirst: async ({ where }: { where: { OR?: { name?: string; slug?: string }[] } }) => {
        const ors = where.OR ?? [];
        return (
          state.teams.find((t) =>
            ors.some((o) => (o.name && t.name === o.name) || (o.slug && t.slug === o.slug))
          ) ?? null
        );
      },
      findMany: async (args: {
        where: { AND?: Array<TeamClause>; id?: { in: string[] } };
        include: { memberships: { where: { userId: string } } };
        select?: Record<string, boolean>;
      }) => {
        // The permissions loader's read of the teams a capability check names.
        if (args.where.id && args.select) {
          const wanted = args.where.id.in;
          return state.teams
            .filter((t) => wanted.includes(t.id))
            .map((t) => ({ id: t.id, isActive: t.isActive ?? true, orgId: t.orgId ?? 'org-1' }));
        }
        const { where, include } = args;
        state.teamQueries = [...(state.teamQueries ?? []), args];
        const clauses = where.AND ?? [];
        // Apply isActive from each row's own flag, not by trusting the shape of the clause.
        const wantsActive = clauses.some((c) => c.isActive === true);
        const matches = (clause: TeamClause, team: TeamRow): boolean =>
          (!clause.AND || clause.AND.every((c) => matches(c, team))) &&
          (!clause.OR || clause.OR.some((c) => matches(c, team))) &&
          (!clause.organization || (state.orgAdminIds ?? []).includes(team.orgId ?? '')) &&
          (!clause.memberships ||
            state.memberships.some(
              (m) =>
                m.teamId === team.id &&
                m.userId === clause.memberships?.some.userId &&
                (!clause.memberships.some.role || clause.memberships.some.role.in.includes(m.role))
            ));
        return state.teams
          .filter((t) => !wantsActive || (t.isActive ?? true))
          .filter((t) => clauses.every((c) => matches(c, t)))
          .map(({ orgName, ...t }) => ({
            ...t,
            _count: { memberships: 0, repositories: 0 },
            memberships: state.memberships
              .filter((m) => m.teamId === t.id && m.userId === include.memberships.where.userId)
              .map((m) => ({ role: m.role })),
            organization: { name: orgName ?? 'Acme' },
            orgId: t.orgId ?? 'org-1',
          }));
      },
      findUnique: async ({
        include,
        where,
      }: {
        include?: Record<string, unknown>;
        where: { id?: string; slug?: string };
      }) => {
        if (include) {
          state.detailIncludes?.push(include);
        }
        const found = state.teams.find((t) =>
          where.id ? t.id === where.id : t.slug === where.slug
        );
        return found ? { orgId: TEAM_ID, ...found } : null;
      },
      findUniqueOrThrow: async () => ({ orgId: TEAM_ID }),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { name?: string; shellImageAllowlist?: string[]; egressAllowlist?: string[] };
      }) => {
        const row = state.teams.find((t) => t.id === where.id);
        if (!row) {
          throw new Error('team not found');
        }
        // The unique index on name.
        if (
          data.name !== undefined &&
          state.teams.some((t) => t.id !== row.id && t.name === data.name)
        ) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        if (data.name !== undefined) {
          row.name = data.name;
        }
        if (data.shellImageAllowlist !== undefined) {
          row.shellImageAllowlist = data.shellImageAllowlist;
        }
        if (data.egressAllowlist !== undefined) {
          row.egressAllowlist = data.egressAllowlist;
        }
        return row;
      },
    },
    teamMembership: {
      count: async ({ where }: { where: { role?: string; teamId: string } }) =>
        state.memberships.filter(
          (m) => m.teamId === where.teamId && (!where.role || m.role === where.role)
        ).length,
      create: async ({ data }: { data: Omit<MembershipRow, 'id'> }) => {
        if (state.createConflict) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `m-${state.memberships.length + 1}`, ...data };
        state.memberships.push(row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const idx = state.memberships.findIndex((m) => m.id === where.id);
        if (idx < 0) {
          throw new Error('membership not found');
        }
        const [removed] = state.memberships.splice(idx, 1);
        return removed;
      },
      findMany: async ({
        where,
      }: {
        where: { teamId: string | { in: string[] }; userId?: string };
      }) => {
        const wanted = typeof where.teamId === 'string' ? [where.teamId] : where.teamId.in;
        return state.memberships
          .filter(
            (m) =>
              wanted.includes(m.teamId) && (where.userId === undefined || m.userId === where.userId)
          )
          .map((m) => ({ role: m.role, teamId: m.teamId }));
      },
      findUnique: async ({
        where,
      }: {
        where: { userId_teamId?: { userId: string; teamId: string } };
      }) => {
        const k = where.userId_teamId;
        if (!k) {
          return null;
        }
        return (
          state.memberships.find((m) => m.userId === k.userId && m.teamId === k.teamId) ?? null
        );
      },
      update: async ({
        data,
        where,
      }: {
        data: Partial<Pick<MembershipRow, 'role'>>;
        where: { id: string };
      }) => {
        const row = state.memberships.find((m) => m.id === where.id);
        if (!row) {
          throw new Error('membership not found');
        }
        Object.assign(row, data);
        return row;
      },
    },
    workerEgressCapability: { findMany: async () => [] },
  };
  app.decorate('prisma', prisma as unknown as never);

  // The shell-allowlist route looks up the team via prisma directly; nothing
  // else needs the verify-PAT path so we leave that decorator out.

  app.register(teamRoutes, { prefix: '/api/v1/teams' });
  app.register(orgTeamRoutes, { prefix: '/api/v1/platform/organizations' });
  app.register(orgTeamRoutes, { prefix: '/api/v1/admin/organizations' });
  return app;
}

afterEach(() => {
  // App instances are throwaway per-test; nothing to clean.
});

describe('organization-bounded team creation', () => {
  it.each([
    [{}, 400, undefined],
    [{ name: 'platform', slug: 'platform' }, 409, 'TEAM_EXISTS'],
  ])('rejects invalid or duplicate organization teams: %j', async (payload, status, code) => {
    const state = freshState();
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload,
      url: `/api/v1/platform/organizations/${TEAM_ID}/teams`,
    });
    expect(res.statusCode).toBe(status);
    if (code) {
      expect(res.json().error.code).toBe(code);
    }
    await app.close();
  });

  it('refuses the unscoped create route to someone who is not an organization admin of the target', async () => {
    const app = buildApp(freshState());
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { name: 'New', slug: 'new' },
      url: '/api/v1/teams',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.missing).toBe('org.teams.create');
    await app.close();
  });

  it('refuses before saying whether the team name is taken', async () => {
    const app = buildApp(freshState());
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { name: 'platform', slug: 'platform' },
      url: '/api/v1/teams',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('lets an organization admin create through the unscoped route, as through the org route', async () => {
    const state = freshState({
      orgMemberships: [{ id: 'org', orgId: 'org-default', role: 'ADMIN', userId: ADMIN_USER_ID }],
    });
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { name: 'New', slug: 'new' },
      url: '/api/v1/teams',
    });
    expect(res.statusCode).toBe(201);
    expect(state.audits?.map((a) => a.entityType)).toEqual(['Team', 'TeamMembership']);
    await app.close();
  });

  it('adds an existing organization member without changing their organization role', async () => {
    const state = freshState({
      memberships: [{ id: 'caller', role: 'LEAD', teamId: TEAM_ID, userId: ADMIN_USER_ID }],
    });
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { userId: TARGET_USER_ID },
      url: `/api/v1/teams/${TEAM_ID}/members`,
    });
    expect(res.statusCode).toBe(201);
    expect(state.audits?.map((a) => a.entityType)).toEqual(['TeamMembership']);
    await app.close();
  });

  for (const prefix of ['/api/v1/platform/organizations', '/api/v1/admin/organizations']) {
    it.each([
      ['ADMIN', TEAM_ID, 201],
      ['MEMBER', TEAM_ID, 403],
      ['ADMIN', TARGET_USER_ID, 403],
    ])(`%s in %s creates through ${prefix} with status %s`, async (role, orgId, status) => {
      const state = freshState({
        orgMemberships: [{ id: 'org', orgId, role, userId: ADMIN_USER_ID }],
      });
      const app = buildApp(state);
      const res = await app.inject({
        headers: { authorization: 'Bearer test' },
        method: 'POST',
        payload: { name: 'New', slug: 'new' },
        url: `${prefix}/${TEAM_ID}/teams`,
      });
      expect(res.statusCode).toBe(status);
      if (status === 201) {
        expect(state.memberships).toContainEqual(
          expect.objectContaining({ role: 'ADMIN', teamId: 'new-team', userId: ADMIN_USER_ID })
        );
        expect(state.audits?.map((a) => a.entityType)).toEqual(['Team', 'TeamMembership']);
      }
      await app.close();
    });
  }

  for (const url of ['/api/v1/teams', `/api/v1/platform/organizations/${TEAM_ID}/teams`]) {
    it.each([true, false])(
      `validates selected admin organization for ${url} (%s)`,
      async (inOrg) => {
        const state = freshState({
          orgMemberships: inOrg
            ? [
                {
                  id: 'org',
                  orgId: url === '/api/v1/teams' ? 'org-default' : TEAM_ID,
                  role: 'MEMBER',
                  userId: TARGET_USER_ID,
                },
              ]
            : [],
          userRole: 'ADMIN',
        });
        const app = buildApp(state);
        const res = await app.inject({
          headers: { authorization: 'Bearer test' },
          method: 'POST',
          payload: { adminUserId: TARGET_USER_ID, name: 'New', slug: 'new' },
          url,
        });
        expect(res.statusCode).toBe(inOrg ? 201 : 400);
        if (inOrg) {
          expect(state.memberships).toContainEqual(
            expect.objectContaining({ role: 'ADMIN', teamId: 'new-team', userId: TARGET_USER_ID })
          );
        } else {
          expect(res.json().error.code).toBe('ORG_MEMBERSHIP_REQUIRED');
        }
        await app.close();
      }
    );

    it(`auto-enrolls the platform ADMIN creator for ${url}`, async () => {
      const state = freshState({ orgMemberships: [], userRole: 'ADMIN' });
      const app = buildApp(state);
      const res = await app.inject({
        headers: { authorization: 'Bearer test' },
        method: 'POST',
        payload: { name: 'New', slug: 'new' },
        url,
      });
      expect(res.statusCode).toBe(201);
      expect(state.orgMemberships).toContainEqual(
        expect.objectContaining({ role: 'MEMBER', userId: ADMIN_USER_ID })
      );
      expect(state.audits?.map((a) => a.entityType)).toEqual([
        'OrganizationMembership',
        'Team',
        'TeamMembership',
      ]);
      await app.close();
    });
  }

  it.each(['USER', 'ADMIN'] as const)('bounds member additions by org for %s', async (userRole) => {
    const state = freshState({
      memberships: [{ id: 'caller', role: 'LEAD', teamId: TEAM_ID, userId: ADMIN_USER_ID }],
      orgMemberships: [],
      userRole,
    });
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { userId: TARGET_USER_ID },
      url: `/api/v1/teams/${TEAM_ID}/members`,
    });
    expect(res.statusCode).toBe(userRole === 'ADMIN' ? 201 : 400);
    if (userRole === 'ADMIN') {
      expect(state.orgMemberships).toContainEqual(
        expect.objectContaining({ orgId: TEAM_ID, role: 'MEMBER', userId: TARGET_USER_ID })
      );
      expect(state.audits?.map((a) => a.entityType)).toEqual([
        'OrganizationMembership',
        'TeamMembership',
      ]);
    } else {
      expect(res.json().error.code).toBe('ORG_MEMBERSHIP_REQUIRED');
    }
    await app.close();
  });
});

describe('GET /api/v1/teams/:id shared repositories', () => {
  const OWNER = { id: 'team-owner', name: 'Owners', slug: 'owners' };
  const repo = (id: string, name: string) => ({
    connection: { id, isActive: true, organizationName: 'acme', repoName: name, team: OWNER },
  });

  it('lists the repositories shared with the team, with their owning team, in name order', async () => {
    const state = freshState({
      shares: [repo('r2', 'zeta'), repo('r1', 'alpha')],
      userRole: 'ADMIN',
    });
    const res = await buildApp(state).inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const { sharedRepositories } = JSON.parse(res.payload).data;
    expect(sharedRepositories.map((r: { repoName: string }) => r.repoName)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(sharedRepositories[0].team).toEqual(OWNER);
    // Scoped to this team and to active rows, like the Connections page.
    expect(state.shareQueries?.[0]?.where).toMatchObject({
      connection: { isActive: true, type: 'git_repo' },
      teamId: TEAM_ID,
    });
  });
});

describe('GET /api/v1/teams/:id members', () => {
  it("selects each member's isActive so a deactivated user can be told apart", async () => {
    const state = freshState({ detailIncludes: [], userRole: 'ADMIN' });
    const res = await buildApp(state).inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(state.detailIncludes?.[0]).toMatchObject({
      memberships: {
        include: { user: { select: { email: true, id: true, isActive: true, role: true } } },
      },
    });
  });
});

describe('GET /api/v1/teams', () => {
  const OTHER_TEAM_ID = '00000000-0000-4000-8000-000000000002';
  const twoTeams = (overrides?: Partial<State>) =>
    freshState({
      teams: [
        {
          egressAllowlist: [],
          id: TEAM_ID,
          name: 'platform',
          orgId: 'org-1',
          orgName: 'Acme',
          shellImageAllowlist: [],
          slug: 'platform',
        },
        {
          egressAllowlist: [],
          id: OTHER_TEAM_ID,
          name: 'zeta',
          orgId: 'org-2',
          orgName: 'Globex',
          shellImageAllowlist: [],
          slug: 'zeta',
        },
      ],
      ...overrides,
    });
  const list = async (state: State, query = '') => {
    const res = await buildApp(state).inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: `/api/v1/teams${query}`,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).data as Array<Record<string, unknown>>;
  };

  it.each(['ADMIN', 'LEAD', 'MEMBER'] as const)(
    'reports a %s membership as myRole',
    async (role) => {
      const state = twoTeams({ userRole: 'USER' });
      state.memberships[0].role = role;
      const data = await list(state);
      expect(data).toHaveLength(1);
      const expected = state.teams[0];
      expect(data[0]).toMatchObject({
        id: TEAM_ID,
        myRole: role,
        orgId: expected.orgId,
        orgName: expected.orgName,
      });
    }
  );

  it('gives a platform ADMIN every team, with a null myRole where they are not a member', async () => {
    const data = await list(twoTeams({ userRole: 'ADMIN' }));
    expect(data.map((t) => [t.id, t.myRole])).toEqual([
      [TEAM_ID, 'LEAD'],
      [OTHER_TEAM_ID, null],
    ]);
  });

  it('lists a platform USER org administrator’s active teams without inventing team membership', async () => {
    const state = twoTeams({ userRole: 'USER' });
    state.orgAdminIds = [state.teams[1].orgId ?? ''];
    expect((await list(state)).map((t) => [t.id, t.myRole])).toEqual([
      [TEAM_ID, 'LEAD'],
      [OTHER_TEAM_ID, null],
    ]);
    expect((await list(state, '?member=true')).map((t) => t.id)).toEqual([TEAM_ID]);
    state.teams[1].isActive = false;
    expect((await list(state)).map((t) => t.id)).toEqual([TEAM_ID]);
  });

  it('narrows a platform ADMIN to their own teams with member=true', async () => {
    const data = await list(twoTeams({ userRole: 'ADMIN' }), '?member=true');
    expect(data.map((t) => t.id)).toEqual([TEAM_ID]);
    const all = await list(twoTeams({ userRole: 'ADMIN' }), '?member=false');
    expect(all).toHaveLength(2);
  });

  it('reports each team its own org', async () => {
    const data = await list(twoTeams({ userRole: 'ADMIN' }));
    expect(data.map((t) => [t.id, t.orgId, t.orgName])).toEqual([
      [TEAM_ID, 'org-1', 'Acme'],
      [OTHER_TEAM_ID, 'org-2', 'Globex'],
    ]);
  });

  it('excludes an inactive team, judged by the row, for an ADMIN and a member alike', async () => {
    for (const userRole of ['ADMIN', 'USER'] as const) {
      const state = twoTeams({ userRole });
      state.teams[0].isActive = false;
      state.memberships.push({
        id: 'm-zeta',
        role: 'LEAD',
        teamId: OTHER_TEAM_ID,
        userId: ADMIN_USER_ID,
      });
      const data = await list(state);
      expect(data.map((t) => t.id)).toEqual([OTHER_TEAM_ID]);
      expect(state.teams.filter((t) => t.isActive !== false).map((t) => t.id)).toEqual([
        OTHER_TEAM_ID,
      ]);
    }
  });

  it("asks prisma for only the caller's own membership role, and no member identity", async () => {
    const state = twoTeams({ userRole: 'ADMIN' });
    await list(state);
    expect(state.teamQueries).toHaveLength(1);
    const include = (state.teamQueries?.[0]?.include ?? {}) as { memberships: { select: unknown } };
    expect(include).toMatchObject({
      memberships: { select: { role: true }, where: { userId: ADMIN_USER_ID } },
      organization: { select: { name: true } },
    });
    expect(include.memberships.select).toEqual({ role: true });
  });

  it('never exposes another member', async () => {
    const data = await list(twoTeams({ userRole: 'ADMIN' }));
    const body = JSON.stringify(data);
    expect(body).not.toContain(TARGET_USER_ID);
    expect(body).not.toContain('MEMBER');
    expect(data.every((t) => !('memberships' in t))).toBe(true);
  });
});

describe('PATCH /api/v1/teams/:id', () => {
  it('409s, not 500s, on a rename onto another team’s name', async () => {
    const state = freshState({
      teams: [
        ...freshState().teams,
        {
          egressAllowlist: [],
          id: '00000000-0000-4000-8000-000000000002',
          name: 'payments',
          shellImageAllowlist: [],
          slug: 'payments',
        },
      ],
    });
    const res = await buildApp(state).inject({
      body: { name: 'payments' },
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TEAM_EXISTS');
    expect(state.teams[0].name).toBe('platform');
    expect(state.audits ?? []).toEqual([]);
  });

  it('renames a team to a free name', async () => {
    const state = freshState();
    const res = await buildApp(state).inject({
      body: { name: 'platform-eng' },
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(state.teams[0].name).toBe('platform-eng');
  });
});

describe('POST /api/v1/teams', () => {
  it('creates a team under the default org when no orgId is given (P5)', async () => {
    const state = freshState({ userRole: 'ADMIN' });
    const app = buildApp(state);

    const res = await app.inject({
      body: { name: 'Payments', slug: 'payments' },
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'POST',
      url: '/api/v1/teams',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().data.orgId).toBe('org-default');
    expect(state.audits).toMatchObject([
      { action: 'CREATE', entityType: 'Team' },
      { action: 'CREATE', entityType: 'TeamMembership' },
    ]);
  });

  it('400s when the requested org does not exist (P5)', async () => {
    const state = freshState({ userRole: 'ADMIN' });
    const app = buildApp(state);

    const res = await app.inject({
      body: { name: 'Payments', orgId: '00000000-0000-4000-8000-0000000000ff', slug: 'payments' },
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'POST',
      url: '/api/v1/teams',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ORG_NOT_FOUND');
  });
});

describe('DELETE /api/v1/teams/:id/members/:userId', () => {
  it('removes the membership row and returns { removed: true }', async () => {
    const state = freshState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { removed: true } });
    // Only the caller's membership should remain.
    expect(state.memberships.map((m) => m.userId)).toEqual([ADMIN_USER_ID]);
  });

  it('404s when the target membership is absent', async () => {
    const state = freshState({ memberships: [freshState().memberships[0]] });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('403s when the caller is not a LEAD in this team', async () => {
    // Caller is a platform USER but only MEMBER in this team — auth.ts:344
    // (the requiredTeamRole check) should reject.
    const state = freshState();
    state.memberships[0].role = 'MEMBER';
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    // And the target membership must still exist — the handler never ran.
    expect(state.memberships.map((m) => m.userId).sort()).toEqual(
      [ADMIN_USER_ID, TARGET_USER_ID].sort()
    );
  });
});

describe('the team role alone decides team management', () => {
  const NEW_USER_ID = '00000000-0000-4000-8000-0000000000cc';
  const headers = { authorization: 'Bearer fake-jwt' };
  const joiner = {
    orgMemberships: [{ id: 'new-user-org', orgId: TEAM_ID, role: 'MEMBER', userId: NEW_USER_ID }],
  };

  it('lets a platform USER who leads the team rename it', async () => {
    const state = freshState({ userRole: 'USER' });
    const res = await buildApp(state).inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(state.teams[0].name).toBe('platform-eng');
  });

  it('lets a platform USER who leads the team remove a member', async () => {
    const state = freshState({ userRole: 'USER' });
    const res = await buildApp(state).inject({
      headers,
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(state.memberships.map((m) => m.userId)).toEqual([ADMIN_USER_ID]);
  });

  it.each([
    ['add a member', 'POST', '/members', { role: 'MEMBER', userId: NEW_USER_ID }, 201],
    ['change a role', 'PATCH', `/members/${TARGET_USER_ID}`, { role: 'LEAD' }, 200],
  ] as const)(
    'lets a platform USER who leads the team: %s',
    async (_name, method, path, payload, status) => {
      const res = await buildApp(freshState({ userRole: 'USER', ...joiner })).inject({
        headers,
        method,
        payload,
        url: `/api/v1/teams/${TEAM_ID}${path}`,
      });
      expect(res.statusCode).toBe(status);
    }
  );

  it('refuses a platform USER who is only a MEMBER of the team', async () => {
    const state = freshState({ userRole: 'USER' });
    state.memberships[0].role = 'MEMBER';
    const res = await buildApp(state).inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(403);
    // The platform-role-free capability refusal, naming what was missing.
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.json().error.missing).toBe('team.settings.manage');
    expect(state.teams[0].name).toBe('platform');
  });

  it('lets a platform ADMIN who is not a member rename the team', async () => {
    const state = freshState({ memberships: [], userRole: 'ADMIN' });
    const res = await buildApp(state).inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a team LEAD who grants a role above their own', async () => {
    const state = freshState({ userRole: 'USER', ...joiner });
    const res = await buildApp(state).inject({
      headers,
      method: 'POST',
      payload: { role: 'ADMIN', userId: NEW_USER_ID },
      url: `/api/v1/teams/${TEAM_ID}/members`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PRIVILEGE_ESCALATION');
  });
});

describe('organization authority over a team', () => {
  const NEW_USER_ID = '00000000-0000-4000-8000-0000000000cc';
  const headers = { authorization: 'Bearer fake-jwt' };

  /** The caller is an org ADMIN of the team's organization with `membership` (if any) in the team. */
  function orgAdminState(
    membership: MembershipRow['role'] | null,
    team: Partial<TeamRow> = {}
  ): State {
    const state = freshState({
      memberships: [
        ...(membership
          ? [{ id: 'm-caller', role: membership, teamId: TEAM_ID, userId: ADMIN_USER_ID }]
          : []),
        { id: 'm-target', role: 'MEMBER', teamId: TEAM_ID, userId: TARGET_USER_ID },
      ],
      orgMemberships: [
        { id: 'org-caller', orgId: TEAM_ID, role: 'ADMIN', userId: ADMIN_USER_ID },
        { id: 'org-new', orgId: TEAM_ID, role: 'MEMBER', userId: NEW_USER_ID },
      ],
      userRole: 'USER',
    });
    Object.assign(state.teams[0] as TeamRow, { orgId: TEAM_ID, ...team });
    return state;
  }

  it.each([null, 'MEMBER', 'LEAD'] as const)(
    'ranks an org ADMIN as ADMIN, so they grant ADMIN (team membership: %s)',
    async (membership) => {
      const state = orgAdminState(membership);
      const res = await buildApp(state).inject({
        headers,
        method: 'POST',
        payload: { role: 'ADMIN', userId: NEW_USER_ID },
        url: `/api/v1/teams/${TEAM_ID}/members`,
      });
      expect(res.statusCode).toBe(201);
    }
  );

  it('lets an org ADMIN rename the team and change a member, without a membership', async () => {
    const state = orgAdminState(null);
    const app = buildApp(state);
    const rename = await app.inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(rename.statusCode).toBe(200);
    const promote = await app.inject({
      headers,
      method: 'PATCH',
      payload: { role: 'ADMIN' },
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });
    expect(promote.statusCode).toBe(200);
  });

  it('still refuses an org ADMIN who removes themselves from the team', async () => {
    const state = orgAdminState('ADMIN');
    state.memberships.push({ id: 'm-other', role: 'ADMIN', teamId: TEAM_ID, userId: NEW_USER_ID });
    const res = await buildApp(state).inject({
      headers,
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${ADMIN_USER_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SELF_REMOVAL');
  });

  it('lets an org ADMIN who is a team member raise their own role', async () => {
    const state = orgAdminState('MEMBER');
    const res = await buildApp(state).inject({
      headers,
      method: 'PATCH',
      payload: { role: 'ADMIN' },
      url: `/api/v1/teams/${TEAM_ID}/members/${ADMIN_USER_ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(state.memberships.find((m) => m.userId === ADMIN_USER_ID)?.role).toBe('ADMIN');
  });

  it('refuses an org ADMIN who lowers their own team role, as SELF_DEMOTION', async () => {
    const state = orgAdminState('ADMIN');
    state.memberships.push({ id: 'm-other', role: 'ADMIN', teamId: TEAM_ID, userId: NEW_USER_ID });
    const res = await buildApp(state).inject({
      headers,
      method: 'PATCH',
      payload: { role: 'LEAD' },
      url: `/api/v1/teams/${TEAM_ID}/members/${ADMIN_USER_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SELF_DEMOTION');
    expect(state.memberships.find((m) => m.userId === ADMIN_USER_ID)?.role).toBe('ADMIN');
  });

  it('refuses a plain team LEAD who raises themselves above their own rank', async () => {
    const state = orgAdminState('LEAD');
    state.orgMemberships = [
      { id: 'org-caller', orgId: TEAM_ID, role: 'MEMBER', userId: ADMIN_USER_ID },
    ];
    const res = await buildApp(state).inject({
      headers,
      method: 'PATCH',
      payload: { role: 'ADMIN' },
      url: `/api/v1/teams/${TEAM_ID}/members/${ADMIN_USER_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PRIVILEGE_ESCALATION');
  });

  it('lets an org ADMIN without a team role rename the team but not set its persona prompt', async () => {
    const state = orgAdminState(null);
    const app = buildApp(state);
    const rename = await app.inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(rename.statusCode).toBe(200);
    const persona = await app.inject({
      body: { defaultPersonaPrompt: 'Start every run you can.' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(persona.statusCode).toBe(403);
    expect(persona.json().error.code).toBe('FORBIDDEN');
    expect(persona.json().error.missing).toBe('team.persona.manage');
  });

  it('lets a team LEAD both rename the team and set its persona prompt', async () => {
    const state = orgAdminState('LEAD');
    state.orgMemberships = [
      { id: 'org-caller', orgId: TEAM_ID, role: 'MEMBER', userId: ADMIN_USER_ID },
    ];
    const app = buildApp(state);
    for (const body of [{ name: 'platform-eng' }, { defaultPersonaPrompt: 'Be brief.' }]) {
      const res = await app.inject({
        body,
        headers,
        method: 'PATCH',
        url: `/api/v1/teams/${TEAM_ID}`,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('still refuses to remove the last team ADMIN for an org ADMIN', async () => {
    const state = orgAdminState(null);
    state.memberships = [{ id: 'm-only', role: 'ADMIN', teamId: TEAM_ID, userId: TARGET_USER_ID }];
    const res = await buildApp(state).inject({
      headers,
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_TEAM_ADMIN');
  });

  it('confers nothing on a deactivated team', async () => {
    const state = orgAdminState(null, { isActive: false });
    const res = await buildApp(state).inject({
      body: { name: 'platform-eng' },
      headers,
      method: 'PATCH',
      url: `/api/v1/teams/${TEAM_ID}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not let an org ADMIN set the sandbox policy: that is the operator’s alone', async () => {
    const state = orgAdminState('ADMIN');
    const res = await buildApp(state).inject({
      headers,
      method: 'PUT',
      payload: { shellImageAllowlist: ['docker.io/library/node:22'] },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.missing).toBe('team.sandbox-policy.manage');
  });

  it('records the authority a team creation was allowed on', async () => {
    const state = freshState({
      orgMemberships: [{ id: 'org', orgId: TEAM_ID, role: 'ADMIN', userId: ADMIN_USER_ID }],
    });
    const app = buildApp(state);
    const res = await app.inject({
      headers,
      method: 'POST',
      payload: { name: 'New', orgId: TEAM_ID, slug: 'new' },
      url: '/api/v1/teams',
    });
    expect(res.statusCode).toBe(201);
    expect(
      state.audits?.every((a) => (a.context as { authority?: string })?.authority === 'org-admin')
    ).toBe(true);
  });
});

describe('team admin floor', () => {
  it('refuses to remove the last team ADMIN, under a row lock on the team', async () => {
    const state = freshState({ userRole: 'ADMIN' });
    state.memberships[1].role = 'ADMIN'; // the only ADMIN
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_TEAM_ADMIN');
    expect(state.locks).toEqual([TEAM_ID]);
    expect(state.memberships).toHaveLength(2);
  });

  it('removes one of two ADMINs, counting under the same lock', async () => {
    const state = freshState({ userRole: 'ADMIN' });
    state.memberships[0].role = 'ADMIN';
    state.memberships[1].role = 'ADMIN';
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(state.locks).toEqual([TEAM_ID]);
    expect(state.memberships.map((m) => m.userId)).toEqual([ADMIN_USER_ID]);
  });

  it('takes the shared team lock for a change that removes no ADMIN', async () => {
    const state = freshState();
    const app = buildApp(state);
    await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'DELETE',
      url: `/api/v1/teams/${TEAM_ID}/members/${TARGET_USER_ID}`,
    });
    expect(state.locks ?? []).toEqual([TEAM_ID]);
  });
});

describe('POST /api/v1/teams/:id/members', () => {
  const NEW_USER_ID = '00000000-0000-4000-8000-0000000000cc';

  it('answers 409 MEMBER_EXISTS when a concurrent add wins the unique index', async () => {
    const state = freshState({
      createConflict: true,
      orgMemberships: [{ id: 'new-user-org', orgId: TEAM_ID, role: 'MEMBER', userId: NEW_USER_ID }],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'POST',
      payload: { role: 'MEMBER', userId: NEW_USER_ID },
      url: `/api/v1/teams/${TEAM_ID}/members`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MEMBER_EXISTS');
    // The organization's row lock first, then the team's.
    expect(state.locks).toEqual([TEAM_ID, TEAM_ID]);
  });

  it('locks the organization before the team and reads the organization membership under it', async () => {
    const ORG = '00000000-0000-4000-8000-0000000000dd';
    const state = freshState({
      orgMemberships: [{ id: 'new-user-org', orgId: TEAM_ID, role: 'MEMBER', userId: NEW_USER_ID }],
    });
    state.teams[0] = { ...state.teams[0], orgId: ORG } as never;
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'POST',
      payload: { role: 'MEMBER', userId: NEW_USER_ID },
      url: `/api/v1/teams/${TEAM_ID}/members`,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(state.locks).toEqual([ORG, TEAM_ID]);
  });

  it('answers 404 for a team that does not exist, before taking any lock', async () => {
    const state = freshState({ userRole: 'ADMIN' });
    const app = buildApp(state);
    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'POST',
      payload: { role: 'MEMBER', userId: NEW_USER_ID },
      url: '/api/v1/teams/00000000-0000-4000-8000-0000000000ee/members',
    });
    expect(res.statusCode).toBe(404);
    expect(state.locks ?? []).toEqual([]);
  });
});

/** Allowlist PUT requires platform ADMIN. Platform ADMIN bypasses the
 *  team-role check, so we just bump userRole; no membership changes needed. */
function adminState(overrides?: Partial<State>): State {
  return freshState({ userRole: 'ADMIN', ...overrides });
}

describe('PUT /api/v1/teams/:id/shell-image-allowlist', () => {
  it('persists the new allowlist and returns it back', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: {
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest', 'docker.io/library/python:3.13-slim'],
      },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest', 'docker.io/library/python:3.13-slim'],
      },
    });
    expect(state.teams[0].shellImageAllowlist).toEqual([
      'ghcr.io/acme/ci-tools:latest',
      'docker.io/library/python:3.13-slim',
    ]);
    expect(state.audits).toMatchObject([
      {
        action: 'UPDATE',
        afterJson: {
          shellImageAllowlist: [
            'ghcr.io/acme/ci-tools:latest',
            'docker.io/library/python:3.13-slim',
          ],
        },
        beforeJson: { shellImageAllowlist: expect.any(Array) },
        entityId: TEAM_ID,
        entityType: 'Team',
      },
    ]);
  });

  it('rejects images with shell metacharacters (the Zod regex guard)', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: {
        // Contains a shell metachar; DOCKER_IMAGE_REF_RE should reject it
        shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest; rm -rf /'],
      },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(400);
    // The allowlist must not have been touched.
    expect(state.teams[0].shellImageAllowlist).toEqual([]);
  });

  it('clears the allowlist when given an empty array (disallowing custom images)', async () => {
    const state = adminState({
      teams: [
        {
          ...freshState().teams[0],
          shellImageAllowlist: ['ghcr.io/acme/ci-tools:latest'],
        },
      ],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { shellImageAllowlist: [] },
      url: `/api/v1/teams/${TEAM_ID}/shell-image-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(state.teams[0].shellImageAllowlist).toEqual([]);
  });
});

describe('GET /api/v1/teams/:id/egress-allowlist', () => {
  it('returns the current egress allowlist for a team member', async () => {
    const state = freshState({
      teams: [{ ...freshState().teams[0], egressAllowlist: ['registry.npmjs.org'] }],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'GET',
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { baselineAllowlist: ['pypi.org'], egressAllowlist: ['registry.npmjs.org'] },
    });
  });

  it('404s when the team does not exist (platform ADMIN bypasses team-RBAC)', async () => {
    // A non-admin hits 403 (no membership) before the handler can return 404,
    // so we use platform ADMIN who skips the team-role check.
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'GET',
      url: '/api/v1/teams/00000000-0000-4000-8000-000000000999/egress-allowlist',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEAM_NOT_FOUND');
  });
});

describe('PUT /api/v1/teams/:id/egress-allowlist', () => {
  it('saves an allowlist with an advisory warning when restricted lacks a proxy', async () => {
    const state = adminState();
    const app = buildApp(state);
    vi.spyOn(app.prisma.workerEgressCapability, 'findMany').mockResolvedValue([
      {
        backend: 'docker',
        detail: '',
        egressProxy: false,
        id: 'worker',
        networkLock: true,
        registryProxy: false,
        reportedAt: new Date(),
      },
    ]);
    Object.assign(app.prisma, {
      configSetting: {
        findMany: async () => [{ scope: 'TEAM', teamId: TEAM_ID, value: 'restricted' }],
      },
    });
    vi.spyOn(app.prisma.team, 'findMany').mockResolvedValue([
      { egressAllowlist: [], id: TEAM_ID, orgId: 'org' },
    ] as never);
    const response = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['example.com'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: { egressAllowlist: ['example.com'] },
      warnings: [expect.stringContaining('no egress proxy')],
    });
    expect(state.teams[0].egressAllowlist).toEqual(['example.com']);
  });
  it('persists the new egress allowlist and returns it', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org', 'api.github.com'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { egressAllowlist: ['registry.npmjs.org', 'api.github.com'] },
    });
    expect(state.teams[0].egressAllowlist).toEqual(['registry.npmjs.org', 'api.github.com']);
    expect(state.audits).toMatchObject([
      {
        action: 'UPDATE',
        afterJson: { egressAllowlist: ['registry.npmjs.org', 'api.github.com'] },
        beforeJson: { egressAllowlist: expect.any(Array) },
        entityId: TEAM_ID,
        entityType: 'Team',
      },
    ]);
  });

  it('rejects invalid hostnames (shell metacharacters)', async () => {
    const state = adminState();
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org; rm -rf /'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(400);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });

  it('clears the allowlist when given an empty array', async () => {
    const state = adminState({
      teams: [{ ...freshState().teams[0], egressAllowlist: ['registry.npmjs.org'] }],
    });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: [] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(200);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });

  it('403s when the caller is not a team ADMIN', async () => {
    // PUT requires requiredTeamRole: 'ADMIN'; a LEAD is rejected.
    const state = freshState({ userRole: 'USER' });
    const app = buildApp(state);

    const res = await app.inject({
      headers: { authorization: 'Bearer fake-jwt' },
      method: 'PUT',
      payload: { egressAllowlist: ['registry.npmjs.org'] },
      url: `/api/v1/teams/${TEAM_ID}/egress-allowlist`,
    });

    expect(res.statusCode).toBe(403);
    expect(state.teams[0].egressAllowlist).toEqual([]);
  });
});
