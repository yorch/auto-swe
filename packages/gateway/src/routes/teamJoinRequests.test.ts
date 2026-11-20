import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Settings by key, or `key@orgId` for an organization override; anything else is the registry default.
const mocks = vi.hoisted(() => ({
  world: undefined as undefined | { settings: Record<string, unknown> },
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@auto-swe/shared/config')>();
  return {
    ...original,
    resolveSetting: vi.fn(async (key: string, ctx?: { orgId?: string }) => {
      const settings = mocks.world?.settings ?? {};
      const scoped = ctx?.orgId ? settings[`${key}@${ctx.orgId}`] : undefined;
      return (
        scoped ??
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
import {
  meJoinRequestRoutes,
  orgJoinRequestRoutes,
  teamJoinRequestRoutes,
} from './teamJoinRequests.js';
import { teamRoutes } from './teams.js';

const ORG_A = uuid(100);
const ORG_B = uuid(101);
const ORG_GONE = uuid(102);
const ALPHA = uuid(200); // org A
const BRAVO = uuid(201); // org B
const CLOSED = uuid(202); // org A, inactive
const DELTA = uuid(203); // org A

const REQUESTER = uuid(1); // member of org A, not of Alpha
const LEAD = uuid(2); // lead of Alpha
const TEAM_ADMIN = uuid(3); // admin of Alpha
const ORG_ADMIN = uuid(4); // admin of org A, not on Alpha
const OUTSIDER = uuid(5); // member of org B only
const MEMBER = uuid(6); // plain member of Alpha
const PLATFORM = uuid(7);
const BRAVO_ADMIN = uuid(8); // org admin of org B

let world: World;
let ctx: WorldApp;
let seq = 0;

function seed(w: World) {
  w.organizations.push(
    { id: ORG_A, isActive: true, name: 'Acme' },
    { id: ORG_B, isActive: true, name: 'Beta' },
    { id: ORG_GONE, isActive: false, name: 'Gone' }
  );
  w.teams.push(
    {
      description: 'Platform work',
      id: ALPHA,
      isActive: true,
      name: 'Alpha',
      orgId: ORG_A,
      slug: 'alpha',
    },
    { description: 'Data', id: BRAVO, isActive: true, name: 'Bravo', orgId: ORG_B, slug: 'bravo' },
    {
      description: 'Old',
      id: CLOSED,
      isActive: false,
      name: 'Charlie',
      orgId: ORG_A,
      slug: 'charlie',
    },
    { description: 'Ops', id: DELTA, isActive: true, name: 'Delta', orgId: ORG_A, slug: 'delta' }
  );
  for (const id of [
    REQUESTER,
    LEAD,
    TEAM_ADMIN,
    ORG_ADMIN,
    OUTSIDER,
    MEMBER,
    PLATFORM,
    BRAVO_ADMIN,
  ]) {
    w.users.push({
      email: `u${id.slice(-2)}@example.com`,
      id,
      isActive: true,
      name: `User ${id.slice(-2)}`,
    });
  }
  const org = (userId: string, orgId: string, role = 'MEMBER') =>
    w.organizationMemberships.push({
      id: uuid(300 + w.organizationMemberships.length),
      orgId,
      role,
      userId,
    });
  org(REQUESTER, ORG_A);
  org(LEAD, ORG_A);
  org(TEAM_ADMIN, ORG_A);
  org(ORG_ADMIN, ORG_A, 'ADMIN');
  org(MEMBER, ORG_A);
  org(OUTSIDER, ORG_B);
  org(BRAVO_ADMIN, ORG_B, 'ADMIN');
  const team = (userId: string, teamId: string, role: string) =>
    w.teamMemberships.push({ id: uuid(400 + w.teamMemberships.length), role, teamId, userId });
  team(LEAD, ALPHA, 'LEAD');
  team(TEAM_ADMIN, ALPHA, 'ADMIN');
  team(MEMBER, ALPHA, 'MEMBER');
  team(OUTSIDER, BRAVO, 'MEMBER');
}

function addRequest(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const now = new Date(Date.now() - 1000 * (1000 - seq));
  const row = {
    createdAt: now,
    grantedRole: null,
    id: uuid(900 + seq),
    message: '',
    orgDecidedAt: null,
    orgDecidedById: null,
    orgDecisionNote: null,
    requiresOrgApproval: false,
    status: 'PENDING_TEAM',
    teamDecidedAt: null,
    teamDecidedById: null,
    teamDecisionNote: null,
    teamId: ALPHA,
    updatedAt: now,
    userId: REQUESTER,
    ...overrides,
  };
  world.teamJoinRequests.push(row);
  // The row is mutated in place by the staged races; its fields are whatever a test sets.
  return row as Record<string, unknown> & { id: string; status: string; teamDecidedById: unknown };
}

function deactivate(userId: string) {
  for (const u of world.users) {
    if (u.id === userId) {
      u.isActive = false;
    }
  }
}

function deactivateTeam(teamId: string) {
  for (const t of world.teams) {
    if (t.id === teamId) {
      t.isActive = false;
    }
  }
}

const as = (sub: string, role: 'ADMIN' | 'USER' = 'USER') => {
  world.actor = { role, sub };
};

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method, payload: payload as never, url });
  return { body: res.json(), res, status: res.statusCode };
}

const audits = (entityType: string) => world.audits.filter((a) => a.entityType === entityType);

beforeEach(async () => {
  seq = 0;
  world = emptyWorld();
  mocks.world = world;
  seed(world);
  ctx = buildWorldApp(world);
  // The directory registers before `teamRoutes`, whose `/:id` must not be the one to answer it.
  await ctx.app.register(teamJoinRequestRoutes, { prefix: '/api/v1/teams' });
  await ctx.app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await ctx.app.register(meJoinRequestRoutes, { prefix: '/api/v1/me' });
  await ctx.app.register(orgJoinRequestRoutes, { prefix: '/api/v1/platform/organizations' });
  await ctx.app.register(orgJoinRequestRoutes, { prefix: '/api/v1/admin/organizations' });
  await ctx.app.ready();
  as(REQUESTER);
});

afterEach(async () => {
  await ctx.app.close();
});

describe('GET /api/v1/teams/directory', () => {
  it('lists the active teams with public fields only, and the caller’s relationship to each', async () => {
    as(MEMBER);
    const open = addRequest({ teamId: DELTA, userId: MEMBER });
    const { body, status } = await call('GET', '/api/v1/teams/directory');
    expect(status).toBe(200);
    expect(body.scope).toBe('platform');
    expect(body.nextCursor).toBeNull();
    // Inactive teams are not listed; the order is by name.
    expect(body.teams.map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Bravo', 'Delta']);
    expect(body.teams[0]).toEqual({
      description: 'Platform work',
      id: ALPHA,
      memberCount: 3,
      name: 'Alpha',
      orgId: ORG_A,
      orgName: 'Acme',
      relationship: 'MEMBER',
      slug: 'alpha',
    });
    expect(body.teams[1]).toMatchObject({ memberCount: 1, relationship: 'NONE' });
    expect('requestId' in body.teams[1]).toBe(false);
    expect(body.teams[2]).toMatchObject({ relationship: 'REQUESTED', requestId: open.id });
  });

  it('leaves out the teams of a deactivated organization', async () => {
    world.teams.push({
      description: '',
      id: uuid(210),
      isActive: true,
      name: 'Zulu',
      orgId: ORG_GONE,
      slug: 'zulu',
    });
    const { body } = await call('GET', '/api/v1/teams/directory');
    expect(body.teams.map((t: { name: string }) => t.name)).not.toContain('Zulu');
  });

  it('counts only active users in memberCount', async () => {
    const before = (await call('GET', '/api/v1/teams/directory')).body.teams.find(
      (t: { id: string }) => t.id === ALPHA
    );
    deactivate(MEMBER);
    const after = (await call('GET', '/api/v1/teams/directory')).body.teams.find(
      (t: { id: string }) => t.id === ALPHA
    );
    expect(after.memberCount).toBe(before.memberCount - 1);
  });

  it('exposes no member, repository, setting or email', async () => {
    const text = JSON.stringify((await call('GET', '/api/v1/teams/directory')).body);
    expect(text).not.toMatch(/example\.com|members|repositor|shellImage|egress|budget/i);
  });

  it('does not show another person’s open request as the caller’s', async () => {
    addRequest({ teamId: DELTA, userId: MEMBER });
    const { body } = await call('GET', '/api/v1/teams/directory');
    expect(body.teams.find((t: { id: string }) => t.id === DELTA).relationship).toBe('NONE');
  });

  it('with directoryScope=organization lists only the teams of the caller’s organizations', async () => {
    world.settings['teams.directoryScope'] = 'organization';
    const { body } = await call('GET', '/api/v1/teams/directory');
    expect(body.scope).toBe('organization');
    expect(body.teams.map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Delta']);
    as(OUTSIDER);
    const outside = await call('GET', '/api/v1/teams/directory');
    expect(outside.body.teams.map((t: { name: string }) => t.name)).toEqual(['Bravo']);
  });

  it('searches name, slug and description without regard to case, and filters by organization', async () => {
    expect((await call('GET', '/api/v1/teams/directory?q=PLATFORM')).body.teams).toHaveLength(1);
    expect((await call('GET', '/api/v1/teams/directory?q=brav')).body.teams[0].name).toBe('Bravo');
    expect((await call('GET', '/api/v1/teams/directory?q=ops')).body.teams[0].slug).toBe('delta');
    expect((await call('GET', '/api/v1/teams/directory?q=nothing-like-this')).body.teams).toEqual(
      []
    );
    const byOrg = await call('GET', `/api/v1/teams/directory?orgId=${ORG_B}`);
    expect(byOrg.body.teams.map((t: { name: string }) => t.name)).toEqual(['Bravo']);
  });

  it('pages by cursor and refuses a cursor it did not issue', async () => {
    const first = await call('GET', '/api/v1/teams/directory?limit=2');
    expect(first.body.teams.map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Bravo']);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await call(
      'GET',
      `/api/v1/teams/directory?limit=2&cursor=${first.body.nextCursor}`
    );
    expect(second.body.teams.map((t: { name: string }) => t.name)).toEqual(['Delta']);
    expect(second.body.nextCursor).toBeNull();
    const bad = await call('GET', '/api/v1/teams/directory?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURSOR');
  });

  it('rejects a malformed query', async () => {
    expect((await call('GET', '/api/v1/teams/directory?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/v1/teams/directory?orgId=nope')).status).toBe(400);
  });

  it('is answered by the directory route, not by /teams/:id', async () => {
    const { body, status } = await call('GET', '/api/v1/teams/directory');
    expect(status).toBe(200);
    expect(body).toHaveProperty('creatableOrgs');
  });

  describe('creatableOrgs', () => {
    it('is empty for a member while self-service creation is off', async () => {
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([]);
    });

    it('lists the organizations the caller belongs to that have it on', async () => {
      world.settings[`teams.selfServiceCreation@${ORG_A}`] = true;
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([
        { id: ORG_A, name: 'Acme' },
      ]);
    });

    it('follows the platform-wide setting for every organization the caller belongs to', async () => {
      world.settings['teams.selfServiceCreation'] = true;
      as(OUTSIDER);
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([
        { id: ORG_B, name: 'Beta' },
      ]);
    });

    it('leaves out an organization the caller has not joined, however it is set', async () => {
      world.settings[`teams.selfServiceCreation@${ORG_B}`] = true;
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([]);
    });

    it('drops it once the caller has created as many teams as the cap allows', async () => {
      world.settings['teams.selfServiceCreation'] = true;
      world.settings['teams.maxCreatedPerUser'] = 2;
      world.teams.push(
        {
          createdById: REQUESTER,
          id: uuid(210),
          isActive: true,
          name: 'M1',
          orgId: ORG_A,
          slug: 'm1',
        },
        {
          createdById: REQUESTER,
          id: uuid(211),
          isActive: true,
          name: 'M2',
          orgId: ORG_A,
          slug: 'm2',
        }
      );
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([]);
      // A deactivated team no longer counts toward it.
      world.teams[world.teams.length - 1].isActive = false;
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([
        { id: ORG_A, name: 'Acme' },
      ]);
    });

    it('applies an organization’s own cap, not another’s', async () => {
      world.settings['teams.selfServiceCreation'] = true;
      world.settings['teams.maxCreatedPerUser'] = 5;
      world.settings[`teams.maxCreatedPerUser@${ORG_A}`] = 1;
      world.teams.push({
        createdById: REQUESTER,
        id: uuid(210),
        isActive: true,
        name: 'M1',
        orgId: ORG_B,
        slug: 'm1',
      });
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([]);
    });

    it('always lists an organization the caller administers, with the setting off and the cap spent', async () => {
      as(ORG_ADMIN);
      world.settings['teams.maxCreatedPerUser'] = 1;
      world.teams.push({
        createdById: ORG_ADMIN,
        id: uuid(210),
        isActive: true,
        name: 'M1',
        orgId: ORG_A,
        slug: 'm1',
      });
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([
        { id: ORG_A, name: 'Acme' },
      ]);
    });

    it('lists every active organization for a platform administrator', async () => {
      as(PLATFORM, 'ADMIN');
      expect((await call('GET', '/api/v1/teams/directory')).body.creatableOrgs).toEqual([
        { id: ORG_A, name: 'Acme' },
        { id: ORG_B, name: 'Beta' },
      ]);
    });
  });
});

describe('POST /api/v1/teams/:id/join-requests', () => {
  const url = (id = ALPHA) => `/api/v1/teams/${id}/join-requests`;

  it('opens a request awaiting the team, for a member of the team’s organization', async () => {
    const { body, status } = await call('POST', url(), { message: '  please  ' });
    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      grantedRole: null,
      message: 'please',
      orgName: 'Acme',
      requiresOrgApproval: false,
      status: 'PENDING_TEAM',
      teamId: ALPHA,
      teamName: 'Alpha',
    });
    expect(world.teamJoinRequests).toHaveLength(1);
    expect(audits('TeamJoinRequest')).toMatchObject([
      { action: 'CREATE', actorId: REQUESTER, entityId: body.data.id },
    ]);
  });

  it('accepts an empty body', async () => {
    const { body, status } = await call('POST', url());
    expect(status).toBe(201);
    expect(body.data.message).toBe('');
  });

  it('marks a request from outside the team’s organization as needing the organization step', async () => {
    as(OUTSIDER);
    const { body, status } = await call('POST', url());
    expect(status).toBe(201);
    expect(body.data.requiresOrgApproval).toBe(true);
  });

  it('answers an unknown, an inactive and an out-of-scope team alike', async () => {
    const unknown = await call('POST', url(uuid(999)));
    const inactive = await call('POST', url(CLOSED));
    world.settings['teams.directoryScope'] = 'organization';
    const outOfScope = await call('POST', url(BRAVO));
    world.settings['teams.directoryScope'] = 'platform';
    world.teams.push({
      description: '',
      id: uuid(210),
      isActive: true,
      name: 'Zulu',
      orgId: ORG_GONE,
      slug: 'zulu',
    });
    const inactiveOrg = await call('POST', url(uuid(210)));
    for (const r of [unknown, inactive, outOfScope, inactiveOrg]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: { code: 'TEAM_NOT_FOUND', message: 'Team not found' } });
    }
    expect(world.teamJoinRequests).toHaveLength(0);
  });

  it('refuses a person who is already a member', async () => {
    as(MEMBER);
    const { body, status } = await call('POST', url());
    expect(status).toBe(409);
    expect(body.error.code).toBe('ALREADY_MEMBER');
  });

  it('refuses a second open request for the same team, at either step', async () => {
    const first = (await call('POST', url())).body.data;
    for (const open of ['PENDING_TEAM', 'PENDING_ORG']) {
      world.teamJoinRequests[0].status = open;
      const again = await call('POST', url());
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('REQUEST_PENDING');
      expect(again.body.error.details).toEqual({ requestId: first.id });
    }
  });

  it('answers REQUEST_PENDING when the unique index loses a race the pre-check could not see', async () => {
    world.failNextRequestCreate = true;
    const { body, status } = await call('POST', url());
    expect(status).toBe(409);
    expect(body.error.code).toBe('REQUEST_PENDING');
    expect(world.audits).toHaveLength(0);
  });

  describe('cooldown after a rejection', () => {
    const rejected = (hoursAgo: number) =>
      addRequest({
        status: 'REJECTED',
        teamDecidedAt: new Date(Date.now() - hoursAgo * 3_600_000),
        updatedAt: new Date(Date.now() - hoursAgo * 3_600_000),
      });

    it('refuses with the time to wait while the cooldown runs', async () => {
      rejected(10);
      const { body, res, status } = await call('POST', url());
      expect(status).toBe(429);
      expect(body.error.code).toBe('JOIN_REQUEST_COOLDOWN');
      // 72 hours from a rejection 10 hours ago.
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(61 * 3600);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(62 * 3600);
      expect(body.error.details.retryAfterSeconds).toBe(Number(res.headers['retry-after']));
    });

    it('allows a new request once it has passed', async () => {
      rejected(73);
      expect((await call('POST', url())).status).toBe(201);
    });

    it('is switched off by a zero cooldown, and read from the setting', async () => {
      rejected(1);
      world.settings['teams.joinRequestCooldownHours'] = 0;
      expect((await call('POST', url())).status).toBe(201);
    });

    it('counts from the organization step when that is where it was rejected', async () => {
      addRequest({
        orgDecidedAt: new Date(Date.now() - 1 * 3_600_000),
        status: 'REJECTED',
        teamDecidedAt: new Date(Date.now() - 200 * 3_600_000),
        updatedAt: new Date(Date.now() - 1 * 3_600_000),
      });
      expect((await call('POST', url())).status).toBe(429);
    });

    it('applies to the team that rejected, not to another', async () => {
      rejected(1);
      expect((await call('POST', url(DELTA))).status).toBe(201);
    });

    it('does not apply to a withdrawn request', async () => {
      addRequest({ status: 'WITHDRAWN' });
      expect((await call('POST', url())).status).toBe(201);
    });
  });

  describe('open-request cap', () => {
    it('refuses a request over the cap, counting both open states across teams', async () => {
      world.settings['teams.maxOpenJoinRequests'] = 2;
      addRequest({ teamId: BRAVO });
      addRequest({ status: 'PENDING_ORG', teamId: DELTA });
      const { body, status } = await call('POST', url());
      expect(status).toBe(429);
      expect(body.error.code).toBe('TOO_MANY_OPEN_REQUESTS');
      expect(world.teamJoinRequests).toHaveLength(2);
    });

    it('does not count a decided or withdrawn request, nor another person’s', async () => {
      world.settings['teams.maxOpenJoinRequests'] = 1;
      addRequest({ status: 'APPROVED', teamId: BRAVO });
      addRequest({ status: 'WITHDRAWN', teamId: DELTA });
      addRequest({ teamId: DELTA, userId: MEMBER });
      expect((await call('POST', url())).status).toBe(201);
    });

    it('takes the one-person lock before counting', async () => {
      await call('POST', url());
      expect(world.locks[0]).toContain('pg_advisory_xact_lock');
      expect(world.locks[0]).toContain(`join-request:${REQUESTER}`);
    });
  });

  it('refuses a message over 500 characters', async () => {
    const { status } = await call('POST', url(), { message: 'x'.repeat(501) });
    expect(status).toBe(400);
  });

  it('rejects a malformed team id', async () => {
    expect((await call('POST', '/api/v1/teams/not-a-uuid/join-requests')).status).toBe(400);
  });
});

describe('GET /api/v1/me/join-requests and withdraw', () => {
  it('lists only the caller’s requests, newest first, with team and organization names', async () => {
    const older = addRequest({ teamId: DELTA });
    const newer = addRequest({ status: 'REJECTED', teamDecisionNote: 'not now', teamId: BRAVO });
    addRequest({ message: 'someone else', teamId: ALPHA, userId: OUTSIDER });
    const { body, status } = await call('GET', '/api/v1/me/join-requests');
    expect(status).toBe(200);
    expect(body.data.map((r: { id: string }) => r.id)).toEqual([newer.id, older.id]);
    expect(body.data[0]).toMatchObject({
      orgName: 'Beta',
      teamDecisionNote: 'not now',
      teamName: 'Bravo',
    });
    expect(JSON.stringify(body)).not.toMatch(/someone else|example\.com/);
  });

  it('says so when the caller has more requests than the 200 it returns', async () => {
    for (let i = 0; i < 200; i += 1) {
      addRequest({ status: 'WITHDRAWN', teamId: DELTA });
    }
    const full = await call('GET', '/api/v1/me/join-requests');
    expect(full.body.data).toHaveLength(200);
    expect(full.body.meta).toEqual({ truncated: false });
    addRequest({ status: 'WITHDRAWN', teamId: DELTA });
    const over = await call('GET', '/api/v1/me/join-requests');
    expect(over.body.data).toHaveLength(200);
    expect(over.body.meta).toEqual({ truncated: true });
  });

  it('withdraws one’s own open request', async () => {
    const row = addRequest();
    const { body, status } = await call('POST', `/api/v1/me/join-requests/${row.id}/withdraw`);
    expect(status).toBe(200);
    expect(body.data.status).toBe('WITHDRAWN');
    expect(world.teamJoinRequests[0].status).toBe('WITHDRAWN');
    expect(audits('TeamJoinRequest')).toMatchObject([{ action: 'UPDATE', actorId: REQUESTER }]);
    // It frees the slot: a new request is allowed at once, with no cooldown.
    expect((await call('POST', `/api/v1/teams/${ALPHA}/join-requests`)).status).toBe(201);
  });

  it('withdraws a request waiting for the organization too', async () => {
    const row = addRequest({ status: 'PENDING_ORG' });
    expect((await call('POST', `/api/v1/me/join-requests/${row.id}/withdraw`)).status).toBe(200);
  });

  it('answers another person’s request as an unknown one and leaves it unchanged', async () => {
    const row = addRequest({ userId: OUTSIDER });
    const { body, status } = await call('POST', `/api/v1/me/join-requests/${row.id}/withdraw`);
    expect(status).toBe(404);
    expect(body.error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
    expect(world.audits).toHaveLength(0);
  });

  it('refuses a request that is already decided', async () => {
    const row = addRequest({ status: 'APPROVED' });
    const { body, status } = await call('POST', `/api/v1/me/join-requests/${row.id}/withdraw`);
    expect(status).toBe(409);
    expect(body.error.code).toBe('REQUEST_NOT_OPEN');
  });

  it('loses to a decision that lands between the read and the write', async () => {
    const row = addRequest();
    world.beforeUpdateMany = () => {
      row.status = 'APPROVED';
    };
    const { body, status } = await call('POST', `/api/v1/me/join-requests/${row.id}/withdraw`);
    expect(status).toBe(409);
    expect(body.error.code).toBe('REQUEST_ALREADY_DECIDED');
    expect(world.teamJoinRequests[0].status).toBe('APPROVED');
    expect(world.audits).toHaveLength(0);
  });
});

describe('team queue and decisions', () => {
  const approve = (id: string, body?: unknown, teamId = ALPHA) =>
    call('POST', `/api/v1/teams/${teamId}/join-requests/${id}/approve`, body);
  const reject = (id: string, body?: unknown, teamId = ALPHA) =>
    call('POST', `/api/v1/teams/${teamId}/join-requests/${id}/reject`, body);

  describe('GET /api/v1/teams/:id/join-requests', () => {
    it('shows a team lead the awaiting requests, with who is asking', async () => {
      as(LEAD);
      const mine = addRequest({ message: 'hello' });
      addRequest({ status: 'APPROVED', userId: OUTSIDER });
      addRequest({ teamId: DELTA, userId: OUTSIDER });
      const { body, status } = await call('GET', `/api/v1/teams/${ALPHA}/join-requests`);
      expect(status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        id: mine.id,
        message: 'hello',
        requester: { email: `u${REQUESTER.slice(-2)}@example.com`, id: REQUESTER },
      });
    });

    it('filters by status, and ALL lists every one of this team’s', async () => {
      as(LEAD);
      addRequest({ status: 'REJECTED' });
      addRequest({ status: 'PENDING_ORG', userId: OUTSIDER });
      addRequest({ teamId: DELTA });
      const rejected = await call('GET', `/api/v1/teams/${ALPHA}/join-requests?status=REJECTED`);
      expect(rejected.body.data).toHaveLength(1);
      const all = await call('GET', `/api/v1/teams/${ALPHA}/join-requests?status=ALL`);
      expect(all.body.data).toHaveLength(2);
      expect((await call('GET', `/api/v1/teams/${ALPHA}/join-requests?status=NOPE`)).status).toBe(
        400
      );
    });

    it.each([
      ['a plain member', MEMBER],
      ['a requester', REQUESTER],
      ['an organization admin of another organization', BRAVO_ADMIN],
    ])('is refused to %s', async (_label, user) => {
      as(user);
      addRequest();
      const { body, status } = await call('GET', `/api/v1/teams/${ALPHA}/join-requests`);
      expect(status).toBe(403);
      expect(JSON.stringify(body)).not.toMatch(/example\.com/);
    });

    it('is open to an organization admin and a platform admin', async () => {
      addRequest();
      as(ORG_ADMIN);
      expect((await call('GET', `/api/v1/teams/${ALPHA}/join-requests`)).body.data).toHaveLength(1);
      as(PLATFORM, 'ADMIN');
      expect((await call('GET', `/api/v1/teams/${ALPHA}/join-requests`)).body.data).toHaveLength(1);
    });
  });

  describe('approve', () => {
    it('adds a same-organization requester as a MEMBER, in one audited step', async () => {
      as(LEAD);
      const row = addRequest({ message: 'x' });
      const { body, status } = await approve(row.id, { note: 'welcome' });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({
        grantedRole: 'MEMBER',
        status: 'APPROVED',
        teamDecisionNote: 'welcome',
      });
      expect(
        world.teamMemberships.find((m) => m.userId === REQUESTER && m.teamId === ALPHA)
      ).toMatchObject({
        role: 'MEMBER',
      });
      expect(world.teamJoinRequests[0]).toMatchObject({
        status: 'APPROVED',
        teamDecidedById: LEAD,
      });
      expect(audits('TeamMembership')).toMatchObject([{ action: 'CREATE', actorId: LEAD }]);
      expect(audits('TeamJoinRequest')).toMatchObject([{ action: 'UPDATE', actorId: LEAD }]);
      // The audit records the ground of the decision.
      expect(
        world.audits.every((a) => (a.context as { authority?: string })?.authority === 'team-role')
      ).toBe(true);
    });

    it('takes the organization lock before the team’s', async () => {
      as(LEAD);
      const row = addRequest();
      await approve(row.id);
      expect(world.locks).toHaveLength(2);
      expect(world.locks[0]).toContain('FROM organizations');
      expect(world.locks[0]).toContain(ORG_A);
      expect(world.locks[1]).toContain('FROM teams');
      expect(world.locks[1]).toContain(ALPHA);
    });

    it('applies the role the approver names, up to their own rank', async () => {
      as(LEAD);
      const row = addRequest();
      const { body } = await approve(row.id, { role: 'LEAD' });
      expect(body.data.grantedRole).toBe('LEAD');
      expect(world.teamMemberships.find((m) => m.userId === REQUESTER)?.role).toBe('LEAD');
    });

    it('refuses a role above the approver’s own rank, and changes nothing', async () => {
      as(LEAD);
      const row = addRequest();
      const { body, status } = await approve(row.id, { role: 'ADMIN' });
      expect(status).toBe(403);
      expect(body.error.code).toBe('PRIVILEGE_ESCALATION');
      expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER)).toBe(false);
      expect(world.audits).toHaveLength(0);
    });

    it.each([
      ['a team ADMIN', TEAM_ADMIN, 'USER'],
      ['an organization admin', ORG_ADMIN, 'USER'],
      ['a platform admin', PLATFORM, 'ADMIN'],
    ] as const)('lets %s grant ADMIN', async (_label, user, role) => {
      as(user, role);
      const row = addRequest();
      expect((await approve(row.id, { role: 'ADMIN' })).status).toBe(200);
      expect(world.teamMemberships.find((m) => m.userId === REQUESTER)?.role).toBe('ADMIN');
    });

    it('records an organization admin’s authority in the audit', async () => {
      as(ORG_ADMIN);
      const row = addRequest();
      await approve(row.id);
      expect(
        world.audits.every((a) => (a.context as { authority?: string })?.authority === 'org-admin')
      ).toBe(true);
    });

    it('moves a cross-organization request to the organization step and adds no one', async () => {
      as(LEAD);
      const row = addRequest({ requiresOrgApproval: true, userId: OUTSIDER });
      const { body, status } = await approve(row.id, { role: 'LEAD' });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ grantedRole: 'LEAD', status: 'PENDING_ORG' });
      expect(world.teamMemberships.some((m) => m.userId === OUTSIDER && m.teamId === ALPHA)).toBe(
        false
      );
      expect(
        world.organizationMemberships.some((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toBe(false);
      expect(audits('TeamMembership')).toHaveLength(0);
      expect(audits('TeamJoinRequest')).toHaveLength(1);
    });

    it('treats a requester who has left the organization since asking as cross-organization', async () => {
      as(LEAD);
      const row = addRequest({ requiresOrgApproval: false, userId: OUTSIDER });
      const { body } = await approve(row.id);
      expect(body.data).toMatchObject({ requiresOrgApproval: true, status: 'PENDING_ORG' });
      expect(world.teamMemberships.some((m) => m.userId === OUTSIDER && m.teamId === ALPHA)).toBe(
        false
      );
    });

    it('needs no second decision from a requester who has joined the organization since asking', async () => {
      as(LEAD);
      const row = addRequest({ requiresOrgApproval: true });
      const { body } = await approve(row.id);
      expect(body.data).toMatchObject({ requiresOrgApproval: false, status: 'APPROVED' });
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER && m.teamId === ALPHA)).toBe(
        true
      );
    });

    it('completes the request without a duplicate when the requester is already a member', async () => {
      as(LEAD);
      const row = addRequest({ userId: MEMBER });
      const before = world.teamMemberships.length;
      const { body, status } = await approve(row.id, { role: 'LEAD' });
      expect(status).toBe(200);
      expect(body.data.status).toBe('APPROVED');
      expect(world.teamMemberships).toHaveLength(before);
      // The existing role is untouched, and it is the one the request records.
      expect(world.teamMemberships.find((m) => m.userId === MEMBER)?.role).toBe('MEMBER');
      expect(body.data.grantedRole).toBe('MEMBER');
      expect(world.teamJoinRequests.find((r) => r.id === row.id)?.grantedRole).toBe('MEMBER');
      expect(audits('TeamMembership')).toHaveLength(0);
    });

    it('completes a cross-organization request of a member without asking the organization', async () => {
      as(LEAD);
      const row = addRequest({ requiresOrgApproval: true, userId: MEMBER });
      expect((await approve(row.id)).body.data.status).toBe('APPROVED');
    });

    it('refuses a requester who is no longer active', async () => {
      as(LEAD);
      deactivate(REQUESTER);
      const row = addRequest();
      const { body, status } = await approve(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('REQUESTER_INACTIVE');
      expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER)).toBe(false);
    });

    it('refuses once the team is no longer active', async () => {
      as(PLATFORM, 'ADMIN');
      const row = addRequest({ teamId: CLOSED });
      const { body, status } = await approve(row.id, undefined, CLOSED);
      expect(status).toBe(409);
      expect(body.error.code).toBe('TEAM_INACTIVE');
      expect(world.teamMemberships.some((m) => m.teamId === CLOSED)).toBe(false);
    });

    it('refuses a request already decided, and one already past the team step', async () => {
      as(LEAD);
      for (const status of ['APPROVED', 'REJECTED', 'WITHDRAWN', 'PENDING_ORG']) {
        const row = addRequest({ status });
        const res = await approve(row.id);
        expect(res.status, status).toBe(409);
        expect(res.body.error.code).toBe('REQUEST_ALREADY_DECIDED');
      }
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER)).toBe(false);
    });

    it('lets only one of two reviewers win a race, and writes nothing for the loser', async () => {
      as(LEAD);
      const row = addRequest();
      // A second reviewer's decision lands after this one read the request and before it claimed it.
      world.beforeUpdateMany = () => {
        row.status = 'REJECTED';
        row.teamDecidedById = TEAM_ADMIN;
      };
      const { body, status } = await approve(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('REQUEST_ALREADY_DECIDED');
      expect(world.teamJoinRequests[0]).toMatchObject({
        status: 'REJECTED',
        teamDecidedById: TEAM_ADMIN,
      });
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER)).toBe(false);
      expect(world.audits).toHaveLength(0);
    });

    it('claims the request before it grants anything', async () => {
      as(LEAD);
      const row = addRequest();
      const order: string[] = [];
      world.beforeUpdateMany = () => order.push('claim');
      world.beforeMembershipCreate = () => order.push('grant');
      await approve(row.id);
      expect(order).toEqual(['claim', 'grant']);
    });

    it('refuses a reviewer deciding their own request', async () => {
      as(PLATFORM, 'ADMIN');
      const row = addRequest({ userId: PLATFORM });
      const { body, status } = await approve(row.id);
      expect(status).toBe(403);
      expect(body.error.code).toBe('SELF_DECISION');
      expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
    });

    it('answers a request of another team as an unknown one, even for an admin of both', async () => {
      as(PLATFORM, 'ADMIN');
      const elsewhere = addRequest({ teamId: DELTA });
      for (const call_ of [approve, reject]) {
        const { body, status } = await call_(elsewhere.id, undefined, ALPHA);
        expect(status).toBe(404);
        expect(body.error.code).toBe('JOIN_REQUEST_NOT_FOUND');
      }
      expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
      expect(world.teamMemberships.some((m) => m.teamId === DELTA)).toBe(false);
    });

    it('is refused to a lead of a different team', async () => {
      world.teamMemberships.push({ id: uuid(450), role: 'LEAD', teamId: DELTA, userId: OUTSIDER });
      as(OUTSIDER);
      const row = addRequest();
      expect((await approve(row.id)).status).toBe(403);
      expect(world.teamJoinRequests[0].status).toBe('PENDING_TEAM');
    });

    it('is refused to a plain member', async () => {
      as(MEMBER);
      const row = addRequest();
      expect((await approve(row.id)).status).toBe(403);
    });

    it('rejects a malformed id, role or note', async () => {
      as(LEAD);
      const row = addRequest();
      expect((await approve('nope')).status).toBe(400);
      expect((await approve(row.id, { role: 'OWNER' })).status).toBe(400);
      expect((await approve(row.id, { note: 'x'.repeat(501) })).status).toBe(400);
    });
  });

  describe('reject', () => {
    it('rejects with a note, makes nobody a member, and starts the cooldown', async () => {
      as(LEAD);
      const row = addRequest();
      const { body, status } = await reject(row.id, { note: 'not a fit' });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ status: 'REJECTED', teamDecisionNote: 'not a fit' });
      expect(world.teamMemberships.some((m) => m.userId === REQUESTER && m.teamId === ALPHA)).toBe(
        false
      );
      expect(audits('TeamJoinRequest')).toMatchObject([{ action: 'UPDATE', actorId: LEAD }]);
      as(REQUESTER);
      const again = await call('POST', `/api/v1/teams/${ALPHA}/join-requests`);
      expect(again.status).toBe(429);
      expect(again.body.error.code).toBe('JOIN_REQUEST_COOLDOWN');
    });

    it('rejects a request with no body', async () => {
      as(LEAD);
      const row = addRequest();
      expect((await reject(row.id)).status).toBe(200);
    });

    it('refuses a request already decided or past the team step', async () => {
      as(LEAD);
      for (const status of ['APPROVED', 'WITHDRAWN', 'PENDING_ORG']) {
        const row = addRequest({ status });
        expect((await reject(row.id)).status, status).toBe(409);
      }
    });

    it('loses a race to another reviewer', async () => {
      as(LEAD);
      const row = addRequest();
      world.beforeUpdateMany = () => {
        row.status = 'APPROVED';
      };
      const { body, status } = await reject(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('REQUEST_ALREADY_DECIDED');
      expect(world.teamJoinRequests[0].status).toBe('APPROVED');
      expect(world.audits).toHaveLength(0);
    });

    it('refuses a reviewer rejecting their own request, and a plain member rejecting anyone’s', async () => {
      const row = addRequest({ userId: LEAD });
      as(LEAD);
      expect((await reject(row.id)).body.error.code).toBe('SELF_DECISION');
      as(MEMBER);
      expect((await reject(row.id)).status).toBe(403);
    });
  });
});

describe('organization step', () => {
  const list = (orgId = ORG_A, query = '', prefix = 'platform') =>
    call('GET', `/api/v1/${prefix}/organizations/${orgId}/join-requests${query}`);
  const approve = (id: string, body?: unknown, orgId = ORG_A, prefix = 'platform') =>
    call('POST', `/api/v1/${prefix}/organizations/${orgId}/join-requests/${id}/approve`, body);
  const reject = (id: string, body?: unknown, orgId = ORG_A) =>
    call('POST', `/api/v1/platform/organizations/${orgId}/join-requests/${id}/reject`, body);

  const waiting = (overrides: Record<string, unknown> = {}) =>
    addRequest({
      grantedRole: 'LEAD',
      requiresOrgApproval: true,
      status: 'PENDING_ORG',
      teamDecidedById: LEAD,
      userId: OUTSIDER,
      ...overrides,
    });

  beforeEach(() => as(ORG_ADMIN));

  describe('GET .../:orgId/join-requests', () => {
    it('lists the cross-organization requests awaiting the organization, for its teams only', async () => {
      const mine = waiting();
      waiting({ teamId: BRAVO, userId: REQUESTER }); // a team of another organization
      addRequest({ userId: MEMBER }); // same-organization: never needs this step
      waiting({ status: 'PENDING_TEAM' });
      const { body, status } = await list();
      expect(status).toBe(200);
      expect(body.data.map((r: { id: string }) => r.id)).toEqual([mine.id]);
      expect(body.data[0]).toMatchObject({
        grantedRole: 'LEAD',
        requester: { id: OUTSIDER },
        teamName: 'Alpha',
      });
    });

    it('filters by status and answers under the admin alias too', async () => {
      waiting({ status: 'REJECTED' });
      expect((await list(ORG_A, '?status=REJECTED')).body.data).toHaveLength(1);
      expect((await list(ORG_A, '?status=ALL')).body.data).toHaveLength(1);
      expect((await list(ORG_A, '', 'admin')).status).toBe(200);
    });

    it.each([
      ['a team lead', LEAD],
      ['a member of the organization', REQUESTER],
      ['an administrator of another organization', BRAVO_ADMIN],
    ])('is refused to %s', async (_label, user) => {
      as(user);
      waiting();
      expect((await list()).status).toBe(403);
    });

    it('is open to a platform admin', async () => {
      waiting();
      as(PLATFORM, 'ADMIN');
      expect((await list()).body.data).toHaveLength(1);
    });
  });

  describe('approve', () => {
    it('creates the organization and team memberships in one audited transaction', async () => {
      const row = waiting();
      const { body, status } = await approve(row.id, { note: 'ok' });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ orgDecisionNote: 'ok', status: 'APPROVED' });
      expect(
        world.organizationMemberships.find((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toMatchObject({
        role: 'MEMBER',
      });
      // The role the team approver granted.
      expect(
        world.teamMemberships.find((m) => m.userId === OUTSIDER && m.teamId === ALPHA)
      ).toMatchObject({
        role: 'LEAD',
      });
      expect(world.teamJoinRequests[0]).toMatchObject({
        orgDecidedById: ORG_ADMIN,
        status: 'APPROVED',
      });
      expect(audits('OrganizationMembership')).toMatchObject([
        { action: 'CREATE', actorId: ORG_ADMIN },
      ]);
      expect(audits('TeamMembership')).toMatchObject([{ action: 'CREATE', actorId: ORG_ADMIN }]);
      expect(audits('TeamJoinRequest')).toMatchObject([{ action: 'UPDATE', actorId: ORG_ADMIN }]);
      expect(
        world.audits.every((a) => (a.context as { authority?: string })?.authority === 'org-admin')
      ).toBe(true);
      expect(world.locks[0]).toContain('FROM organizations');
      expect(world.locks[1]).toContain('FROM teams');
    });

    it('grants MEMBER when the team step named no role', async () => {
      const row = waiting({ grantedRole: null });
      await approve(row.id);
      expect(
        world.teamMemberships.find((m) => m.userId === OUTSIDER && m.teamId === ALPHA)?.role
      ).toBe('MEMBER');
    });

    it('works under the admin alias', async () => {
      const row = waiting();
      expect((await approve(row.id, undefined, ORG_A, 'admin')).status).toBe(200);
    });

    it('does not duplicate a membership the requester gained in the meantime', async () => {
      const row = waiting();
      world.organizationMemberships.push({
        id: uuid(470),
        orgId: ORG_A,
        role: 'MEMBER',
        userId: OUTSIDER,
      });
      world.teamMemberships.push({
        id: uuid(471),
        role: 'MEMBER',
        teamId: ALPHA,
        userId: OUTSIDER,
      });
      expect((await approve(row.id)).status).toBe(200);
      expect(
        world.organizationMemberships.filter((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toHaveLength(1);
      expect(
        world.teamMemberships.filter((m) => m.userId === OUTSIDER && m.teamId === ALPHA)
      ).toHaveLength(1);
      expect(audits('OrganizationMembership')).toHaveLength(0);
      expect(audits('TeamMembership')).toHaveLength(0);
    });

    it('answers a request of another organization as an unknown one, whoever asks', async () => {
      const elsewhere = waiting({ teamId: BRAVO, userId: REQUESTER });
      for (const user of [ORG_ADMIN, PLATFORM]) {
        as(user, user === PLATFORM ? 'ADMIN' : 'USER');
        for (const decide of [approve, reject]) {
          const { body, status } = await decide(elsewhere.id);
          expect(status).toBe(404);
          expect(body.error.code).toBe('JOIN_REQUEST_NOT_FOUND');
        }
      }
      expect(world.teamJoinRequests[0].status).toBe('PENDING_ORG');
      expect(
        world.organizationMemberships.some((m) => m.userId === REQUESTER && m.orgId === ORG_B)
      ).toBe(false);
    });

    it('refuses a request still waiting for the team, and one already decided', async () => {
      for (const status of ['PENDING_TEAM', 'APPROVED', 'REJECTED', 'WITHDRAWN']) {
        const row = waiting({ status });
        const res = await approve(row.id);
        expect(res.status, status).toBe(409);
        expect(res.body.error.code).toBe('REQUEST_ALREADY_DECIDED');
      }
      expect(
        world.organizationMemberships.some((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toBe(false);
    });

    it('lets only one of two decisions win, and writes nothing for the loser', async () => {
      const row = waiting();
      world.beforeUpdateMany = () => {
        row.status = 'WITHDRAWN';
      };
      const { body, status } = await approve(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('REQUEST_ALREADY_DECIDED');
      expect(world.teamJoinRequests[0].status).toBe('WITHDRAWN');
      expect(
        world.organizationMemberships.some((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toBe(false);
      expect(world.teamMemberships.some((m) => m.userId === OUTSIDER && m.teamId === ALPHA)).toBe(
        false
      );
      expect(world.audits).toHaveLength(0);
    });

    it('refuses a requester who is no longer active', async () => {
      deactivate(OUTSIDER);
      const row = waiting();
      const { body, status } = await approve(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('REQUESTER_INACTIVE');
      expect(world.teamJoinRequests[0].status).toBe('PENDING_ORG');
    });

    it('refuses once the team is no longer active', async () => {
      const row = waiting();
      deactivateTeam(ALPHA);
      const { body, status } = await approve(row.id);
      expect(status).toBe(409);
      expect(body.error.code).toBe('TEAM_INACTIVE');
    });

    it('refuses an administrator deciding their own request', async () => {
      const row = waiting({ userId: ORG_ADMIN });
      expect((await approve(row.id)).body.error.code).toBe('SELF_DECISION');
    });

    it('is refused to a team lead who is not an administrator of the organization', async () => {
      as(LEAD);
      const row = waiting();
      expect((await approve(row.id)).status).toBe(403);
      expect(world.teamJoinRequests[0].status).toBe('PENDING_ORG');
    });
  });

  describe('reject', () => {
    it('rejects with a note and adds no membership', async () => {
      const row = waiting();
      const { body, status } = await reject(row.id, { note: 'no' });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({ orgDecisionNote: 'no', status: 'REJECTED' });
      expect(world.teamJoinRequests[0].orgDecidedById).toBe(ORG_ADMIN);
      expect(
        world.organizationMemberships.some((m) => m.userId === OUTSIDER && m.orgId === ORG_A)
      ).toBe(false);
      expect(audits('TeamJoinRequest')).toHaveLength(1);
    });

    it('refuses a request still waiting for the team', async () => {
      const row = waiting({ status: 'PENDING_TEAM' });
      expect((await reject(row.id)).status).toBe(409);
    });

    it('loses a race to another decision', async () => {
      const row = waiting();
      world.beforeUpdateMany = () => {
        row.status = 'APPROVED';
      };
      expect((await reject(row.id)).status).toBe(409);
      expect(world.teamJoinRequests[0].status).toBe('APPROVED');
    });
  });
});

describe('the whole journey', () => {
  it('takes a request from another organization through both steps', async () => {
    as(OUTSIDER);
    const created = (await call('POST', `/api/v1/teams/${ALPHA}/join-requests`, { message: 'hi' }))
      .body.data;
    expect(created.status).toBe('PENDING_TEAM');

    as(LEAD);
    const team = await call('POST', `/api/v1/teams/${ALPHA}/join-requests/${created.id}/approve`, {
      role: 'MEMBER',
    });
    expect(team.body.data.status).toBe('PENDING_ORG');

    as(ORG_ADMIN);
    const org = await call(
      'POST',
      `/api/v1/platform/organizations/${ORG_A}/join-requests/${created.id}/approve`
    );
    expect(org.body.data.status).toBe('APPROVED');

    as(OUTSIDER);
    const mine = await call('GET', '/api/v1/me/join-requests');
    expect(mine.body.data[0]).toMatchObject({ id: created.id, status: 'APPROVED' });
    const directory = await call('GET', '/api/v1/teams/directory?q=alpha');
    expect(directory.body.teams[0].relationship).toBe('MEMBER');
  });
});
