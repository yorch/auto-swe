import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Settings by key, or `key@orgId` for an organization override; anything else is the registry default.
const mocks = vi.hoisted(() => ({
  world: undefined as undefined | { settings: Record<string, unknown> },
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@auto-swe/shared/config')>();
  const resolve = (key: string, orgId?: string) => {
    const settings = mocks.world?.settings ?? {};
    const scoped = orgId ? settings[`${key}@${orgId}`] : undefined;
    return (
      scoped ??
      settings[key] ??
      (original.SETTING_DEFINITIONS as Record<string, { defaultValue: unknown }>)[key]?.defaultValue
    );
  };
  return {
    ...original,
    resolveSetting: vi.fn(async (key: string, ctx?: { orgId?: string }) =>
      resolve(key, ctx?.orgId)
    ),
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
import { teamJoinRequestRoutes } from './teamJoinRequests.js';
import { teamRoutes } from './teams.js';

const VIEWER = uuid(1); // a member of Acme
const OUTSIDER = uuid(2); // a member of nothing

// name order: Acme < Beta < Cobalt < Delta < Echo < Foxtrot
const ACME = uuid(100); // the viewer's own
const BETA = uuid(101);
const COBALT = uuid(102); // chose `organization`
const DELTA = uuid(103); // chose `platform`
const ECHO = uuid(104); // inactive
const FOXTROT = uuid(105); // active, but no active team

let world: World;
let ctx: WorldApp;

function seed(w: World) {
  const org = (id: string, name: string, isActive = true) =>
    w.organizations.push({ id, isActive, name });
  org(ACME, 'Acme');
  org(BETA, 'Beta');
  org(COBALT, 'Cobalt');
  org(DELTA, 'Delta');
  org(ECHO, 'Echo', false);
  org(FOXTROT, 'Foxtrot');
  let n = 200;
  const team = (orgId: string, isActive = true) => {
    n += 1;
    w.teams.push({ description: '', id: uuid(n), isActive, name: `T${n}`, orgId, slug: `t${n}` });
  };
  team(ACME);
  team(BETA);
  team(COBALT);
  team(DELTA);
  team(ECHO);
  team(FOXTROT, false);
  for (const id of [VIEWER, OUTSIDER]) {
    w.users.push({
      email: `u${id.slice(-2)}@example.com`,
      id,
      isActive: true,
      name: 'U',
      role: 'USER',
    });
  }
  w.organizationMemberships.push({ id: uuid(300), orgId: ACME, role: 'MEMBER', userId: VIEWER });
}

const as = (sub: string) => {
  world.actor = { role: 'USER', sub };
};
const get = async (query = '') => {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/teams/directory/organizations${query}`,
  });
  return { body: res.json(), status: res.statusCode };
};
const names = (body: { organizations: Array<{ name: string }> }) =>
  body.organizations.map((o) => o.name);

beforeEach(async () => {
  world = emptyWorld();
  mocks.world = world;
  seed(world);
  ctx = buildWorldApp(world);
  // The directory registers before `teamRoutes`, whose `/:id` must not be the one to answer it.
  await ctx.app.register(teamJoinRequestRoutes, { prefix: '/api/v1/teams' });
  await ctx.app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await ctx.app.ready();
  as(VIEWER);
});

afterEach(async () => {
  await ctx.app.close();
});

describe('GET /api/v1/teams/directory/organizations', () => {
  it('lists the organizations with an active team, by name, as id and name only', async () => {
    const { body, status } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      nextCursor: null,
      organizations: [
        { id: ACME, name: 'Acme' },
        { id: BETA, name: 'Beta' },
        { id: COBALT, name: 'Cobalt' },
        { id: DELTA, name: 'Delta' },
      ],
    });
  });

  it('never names an inactive organization or one with no active team', async () => {
    expect(names((await get()).body)).not.toContain('Echo');
    expect(names((await get()).body)).not.toContain('Foxtrot');
  });

  it('applies the directory rule: organization scope shows the caller’s own and those that chose platform', async () => {
    world.settings['teams.directoryScope'] = 'organization';
    world.settings[`teams.directoryScope@${DELTA}`] = 'platform';
    expect(names((await get()).body)).toEqual(['Acme', 'Delta']);
    as(OUTSIDER);
    expect(names((await get()).body)).toEqual(['Delta']);
  });

  it('hides an organization that chose `organization` from a caller outside it, under the platform value', async () => {
    world.settings[`teams.directoryScope@${COBALT}`] = 'organization';
    expect(names((await get()).body)).toEqual(['Acme', 'Beta', 'Delta']);
    // Its own members still see it.
    world.organizationMemberships.push({
      id: uuid(301),
      orgId: COBALT,
      role: 'MEMBER',
      userId: OUTSIDER,
    });
    as(OUTSIDER);
    expect(names((await get()).body)).toEqual(['Acme', 'Beta', 'Cobalt', 'Delta']);
  });

  it('treats an invalid override as none', async () => {
    world.settings[`teams.directoryScope@${COBALT}`] = 'Organization';
    expect(names((await get()).body)).toContain('Cobalt');
  });

  it('searches the name case-insensitively', async () => {
    expect(names((await get('?q=OB')).body)).toEqual(['Cobalt']);
    expect(names((await get('?q=%20ob%20')).body)).toEqual(['Cobalt']);
    expect(names((await get('?q=e')).body)).toEqual(['Acme', 'Beta', 'Delta']);
    expect((await get('?q=zzz')).body).toEqual({ nextCursor: null, organizations: [] });
  });

  it('pages by name with a cursor, each organization once', async () => {
    const first = await get('?limit=3');
    expect(names(first.body)).toEqual(['Acme', 'Beta', 'Cobalt']);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(`?limit=3&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(names(second.body)).toEqual(['Delta']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('answers 400 INVALID_CURSOR for a cursor this API did not issue', async () => {
    const { body, status } = await get('?cursor=not-a-cursor');
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain('INVALID_CURSOR');
  });

  it('rejects a limit outside 1-100', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect((await get('?limit=101')).status).toBe(400);
    expect((await get('?limit=100')).status).toBe(200);
  });

  it('is not read as a team id', async () => {
    // `/teams/:id` is a UUID route; the static segment must win.
    expect((await get()).status).toBe(200);
  });
});
