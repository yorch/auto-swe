import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  world: undefined as undefined | { settings: Record<string, unknown> },
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@auto-swe/shared/config')>();
  return {
    ...original,
    resolveSetting: vi.fn(async (key: string, ctx?: { orgId?: string }) => {
      const settings = mocks.world?.settings ?? {};
      return (
        (ctx?.orgId ? settings[`${key}@${ctx.orgId}`] : undefined) ??
        settings[key] ??
        (original.SETTING_DEFINITIONS as Record<string, { defaultValue: unknown }>)[key]
          ?.defaultValue
      );
    }),
  };
});

import '../test/warmAuthImports.js';
import {
  buildWorldApp,
  emptyWorld,
  uuid,
  type World,
  type WorldApp,
} from '../test/joinRequestWorld.js';
import { orgTeamRoutes } from './teams.js';

const ORG_A = uuid(100);
const ORG_B = uuid(101);
const MEMBER = uuid(1); // member of org A
const OTHER = uuid(2); // member of org A
const ORG_ADMIN = uuid(3); // admin of org A
const OUTSIDER = uuid(4); // member of org B only
const PLATFORM = uuid(5);

let world: World;
let ctx: WorldApp;

const as = (sub: string, role: 'ADMIN' | 'USER' = 'USER') => {
  world.actor = { role, sub };
};

const create = async (orgId: string, body: Record<string, unknown> = {}, prefix = 'platform') => {
  const res = await ctx.app.inject({
    method: 'POST',
    payload: { description: 'd', name: 'New team', slug: 'new-team', ...body },
    url: `/api/v1/${prefix}/organizations/${orgId}/teams`,
  });
  return { body: res.json(), status: res.statusCode };
};

const owned = (userId: string, count: number, isActive = true) => {
  for (let i = 0; i < count; i += 1) {
    world.teams.push({
      createdById: userId,
      id: uuid(600 + world.teams.length),
      isActive,
      name: `Owned ${world.teams.length}`,
      orgId: ORG_B,
      slug: `owned-${world.teams.length}`,
    });
  }
};

beforeEach(async () => {
  world = emptyWorld();
  mocks.world = world;
  world.organizations.push(
    { id: ORG_A, isActive: true, name: 'Acme' },
    { id: ORG_B, isActive: true, name: 'Beta' }
  );
  for (const [i, userId] of [MEMBER, OTHER, ORG_ADMIN, OUTSIDER, PLATFORM].entries()) {
    world.users.push({ email: `u${i}@example.com`, id: userId, isActive: true });
  }
  const org = (userId: string, orgId: string, role = 'MEMBER') =>
    world.organizationMemberships.push({
      id: uuid(300 + world.organizationMemberships.length),
      orgId,
      role,
      userId,
    });
  org(MEMBER, ORG_A);
  org(OTHER, ORG_A);
  org(ORG_ADMIN, ORG_A, 'ADMIN');
  org(OUTSIDER, ORG_B);
  ctx = buildWorldApp(world);
  await ctx.app.register(orgTeamRoutes, { prefix: '/api/v1/platform/organizations' });
  await ctx.app.register(orgTeamRoutes, { prefix: '/api/v1/admin/organizations' });
  await ctx.app.ready();
  as(MEMBER);
});

afterEach(async () => {
  await ctx.app.close();
});

describe('POST /api/v1/platform/organizations/:orgId/teams: self-service creation', () => {
  it('is refused to a member while the setting is off, as it always was', async () => {
    const { body, status } = await create(ORG_A);
    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(world.teams).toHaveLength(0);
  });

  it('lets a member of the organization create a team once it is on, and makes them its admin', async () => {
    world.settings[`teams.selfServiceCreation@${ORG_A}`] = true;
    const { body, status } = await create(ORG_A);
    expect(status).toBe(201);
    expect(body.data).toMatchObject({ createdById: MEMBER, name: 'New team', orgId: ORG_A });
    expect(world.teamMemberships).toMatchObject([
      { role: 'ADMIN', teamId: body.data.id, userId: MEMBER },
    ]);
    expect(world.audits.map((a) => a.entityType)).toEqual(['Team', 'TeamMembership']);
    expect(
      world.audits.every((a) => (a.context as { authority?: string })?.authority === 'org-member')
    ).toBe(true);
    // The person's own advisory lock is taken before the organization's row lock.
    expect(world.locks[0]).toContain('pg_advisory_xact_lock');
    expect(world.locks[0]).toContain(`team-create:${MEMBER}`);
    expect(world.locks[1]).toContain('FROM organizations');
  });

  it('follows the platform-wide setting and the deprecated admin alias', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    expect((await create(ORG_A, {}, 'admin')).status).toBe(201);
  });

  it('is refused to someone who has not joined the organization, whatever the setting', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    as(OUTSIDER);
    const { body, status } = await create(ORG_A);
    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(world.teams).toHaveLength(0);
  });

  it('is refused for an inactive organization', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    world.organizations[0].isActive = false;
    expect((await create(ORG_A)).status).toBe(403);
  });

  it('does not let a member appoint someone else as the team admin', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    const { status } = await create(ORG_A, { adminUserId: OTHER });
    expect(status).toBe(403);
    expect(world.teams).toHaveLength(0);
    // Naming themselves is fine.
    expect((await create(ORG_A, { adminUserId: MEMBER })).status).toBe(201);
  });

  it('stops at teams.maxCreatedPerUser with TEAM_LIMIT_REACHED and creates nothing', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    world.settings['teams.maxCreatedPerUser'] = 2;
    owned(MEMBER, 2);
    const before = world.teams.length;
    const { body, status } = await create(ORG_A);
    expect(status).toBe(409);
    expect(body.error.code).toBe('TEAM_LIMIT_REACHED');
    expect(world.teams).toHaveLength(before);
    expect(world.teamMemberships).toHaveLength(0);
    expect(world.audits).toHaveLength(0);
  });

  it('counts the teams the person created in any organization, and only active ones', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    world.settings['teams.maxCreatedPerUser'] = 2;
    owned(MEMBER, 1);
    owned(MEMBER, 1, false);
    owned(OTHER, 5);
    expect((await create(ORG_A)).status).toBe(201);
    // The second creation is the person's third team, counting the first one made elsewhere.
    expect((await create(ORG_A, { name: 'Another', slug: 'another' })).body.error.code).toBe(
      'TEAM_LIMIT_REACHED'
    );
  });

  it('reads the cap for the organization it creates in', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    world.settings['teams.maxCreatedPerUser'] = 10;
    world.settings[`teams.maxCreatedPerUser@${ORG_A}`] = 1;
    expect((await create(ORG_A)).status).toBe(201);
    expect((await create(ORG_A, { name: 'Another', slug: 'another' })).status).toBe(409);
  });

  it('still reports a name or slug that is taken as TEAM_EXISTS', async () => {
    world.settings['teams.selfServiceCreation'] = true;
    world.teams.push({ id: uuid(700), isActive: true, name: 'New team', orgId: ORG_B, slug: 'x' });
    const { body, status } = await create(ORG_A);
    expect(status).toBe(409);
    expect(body.error.code).toBe('TEAM_EXISTS');
  });
});

describe('POST /api/v1/platform/organizations/:orgId/teams: the administrator path', () => {
  it('lets an organization admin create with the setting off, without the cap, and names no creator', async () => {
    as(ORG_ADMIN);
    owned(ORG_ADMIN, 5);
    world.settings['teams.maxCreatedPerUser'] = 1;
    const { body, status } = await create(ORG_A);
    expect(status).toBe(201);
    expect(body.data.createdById).toBeNull();
    expect(world.teamMemberships).toMatchObject([{ role: 'ADMIN', userId: ORG_ADMIN }]);
    expect(world.locks.some((l) => l.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(
      world.audits.every((a) => (a.context as { authority?: string })?.authority === 'org-admin')
    ).toBe(true);
  });

  it('lets an organization admin appoint another member as the team admin', async () => {
    as(ORG_ADMIN);
    const { body, status } = await create(ORG_A, { adminUserId: OTHER });
    expect(status).toBe(201);
    expect(world.teamMemberships[0]).toMatchObject({ teamId: body.data.id, userId: OTHER });
  });

  it('lets a platform admin create in any organization', async () => {
    as(PLATFORM, 'ADMIN');
    const { body, status } = await create(ORG_B);
    expect(status).toBe(201);
    expect(body.data.createdById).toBeNull();
  });

  it('answers a missing organization to an administrator as before, and refuses everyone else alike', async () => {
    as(PLATFORM, 'ADMIN');
    const missing = await create(uuid(999));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('ORG_NOT_FOUND');
    as(MEMBER);
    world.settings['teams.selfServiceCreation'] = true;
    expect((await create(uuid(999))).status).toBe(403);
  });

  it('refuses an organization admin of a different organization', async () => {
    as(ORG_ADMIN);
    world.settings['teams.selfServiceCreation'] = true;
    // A member of A only: B is not theirs, and being an admin of A confers nothing in B.
    const { status } = await create(ORG_B);
    expect(status).toBe(403);
  });
});
