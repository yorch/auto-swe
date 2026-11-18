import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { assertHandlerChecked, can } from '../lib/authz.js';
import {
  type AuthzKind,
  annotateAuthz,
  appendHandlerCheckedBackstop,
  assertServiceScopesAdmissible,
  authzKindOf,
  type JwtPayload,
  requireAuth,
} from './auth.js';

/**
 * `requireAuth({ capability })` and its companions, driven against fake request/reply objects the
 * way `auth.hook.test.ts` drives the role options. The resolver itself is covered in
 * `packages/shared/src/permissions`; this file checks the gateway's binding: the 403 body, the 404
 * option, the resource parameters, `request.authority`, and the route-registration checks.
 */

const TEAM = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

interface FakeReply {
  statusCode: number | undefined;
  body: unknown;
  status(code: number): FakeReply;
  send(body: unknown): FakeReply;
}

function makeReply(): FakeReply {
  const reply: FakeReply = {
    body: undefined,
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    statusCode: undefined,
  };
  return reply;
}

interface World {
  role?: string;
  /** Stored team-membership role in TEAM. */
  teamRole?: string;
  /** Stored org-membership role in ORG, the organization owning TEAM. */
  orgRole?: string;
  active?: boolean;
  params?: Record<string, string>;
}

function makeRequest(world: World = {}) {
  const prisma = {
    organizationMembership: {
      findMany: vi.fn(async () => (world.orgRole ? [{ orgId: ORG, role: world.orgRole }] : [])),
    },
    team: {
      findMany: vi.fn(async () => [{ id: TEAM, isActive: world.active ?? true, orgId: ORG }]),
    },
    teamMembership: {
      findMany: vi.fn(async () => (world.teamRole ? [{ role: world.teamRole, teamId: TEAM }] : [])),
      // The old `requiredTeamRole` path.
      findUnique: vi.fn(async () =>
        world.teamRole ? { role: world.teamRole, teamId: TEAM } : null
      ),
    },
  };
  const user: JwtPayload = {
    exp: 9_999_999_999,
    iat: 0,
    role: (world.role ?? 'ENGINEER') as never,
    sub: 'u1',
  };
  const request = {
    headers: { authorization: 'Bearer jwt' },
    log: { error: vi.fn(), warn: vi.fn() },
    method: 'GET',
    params: world.params ?? { id: TEAM },
    routeOptions: { config: {}, url: '/x/:id' },
    server: {
      auth: { hashToken: (t: string) => t, verifyAccessToken: () => user },
      prisma,
    },
  };
  return { prisma, request: request as unknown as FastifyRequest };
}

async function run(opts: Parameters<typeof requireAuth>[0], world: World = {}) {
  const { request } = makeRequest(world);
  const reply = makeReply();
  await requireAuth(opts)(request, reply as unknown as FastifyReply);
  return { reply, request };
}

describe('requireAuth — capability', () => {
  it('lets a team LEAD through a LEAD capability and records the authority and stored role', async () => {
    const { reply, request } = await run(
      { capability: 'team.templates.write' },
      { teamRole: 'LEAD' }
    );
    expect(reply.statusCode).toBeUndefined();
    expect(request.authority).toBe('team-role');
    expect(request.teamRole).toBe('LEAD');
  });

  it('refuses a team ENGINEER with 403 FORBIDDEN naming the missing capability', async () => {
    const { reply } = await run({ capability: 'team.templates.write' }, { teamRole: 'ENGINEER' });
    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      error: { code: 'FORBIDDEN', missing: 'team.templates.write' },
    });
  });

  it('can answer a refusal as a 404 for a route that hides existence', async () => {
    const { reply } = await run({ capability: 'team.templates.write', hideAs404: true });
    expect(reply.statusCode).toBe(404);
    expect(reply.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('reads the team from the named parameter', async () => {
    const { reply } = await run(
      { capability: 'team.templates.write', team: { param: 'teamId' } },
      { params: { teamId: TEAM }, teamRole: 'ADMIN' }
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('refuses a malformed team id with 400 and a missing parameter with 500', async () => {
    const bad = await run({ capability: 'team.read' }, { params: { id: 'nope' } });
    expect(bad.reply.statusCode).toBe(400);
    const missing = await run({ capability: 'team.read' }, { params: {} });
    expect(missing.reply.statusCode).toBe(500);
  });

  it('applies the org rule to a governance capability and not to an operation', async () => {
    const governance = await run({ capability: 'team.repos.manage' }, { orgRole: 'ORG_ADMIN' });
    expect(governance.reply.statusCode).toBeUndefined();
    expect(governance.request.authority).toBe('org-admin');
    const operation = await run({ capability: 'team.templates.write' }, { orgRole: 'ORG_ADMIN' });
    expect(operation.reply.statusCode).toBe(403);
  });

  it('lets platform ADMIN through with authority platform-admin', async () => {
    const { reply, request } = await run({ capability: 'team.secrets.manage' }, { role: 'ADMIN' });
    expect(reply.statusCode).toBeUndefined();
    expect(request.authority).toBe('platform-admin');
  });

  it('decides a platform capability with no resource', async () => {
    const refused = await run({ capability: 'platform.users.manage' }, { params: {} });
    expect(refused.reply.statusCode).toBe(403);
    const allowed = await run(
      { capability: 'platform.users.manage' },
      { params: {}, role: 'ADMIN' }
    );
    expect(allowed.reply.statusCode).toBeUndefined();
  });

  it('decides an org capability from the org parameter', async () => {
    const ok = await run(
      { capability: 'org.settings.manage' },
      { orgRole: 'ORG_ADMIN', params: { orgId: ORG } }
    );
    expect(ok.reply.statusCode).toBeUndefined();
    const no = await run(
      { capability: 'org.settings.manage' },
      { orgRole: 'ORG_MEMBER', params: { orgId: ORG } }
    );
    expect(no.reply.statusCode).toBe(403);
  });

  it('keeps the old role options working beside it', async () => {
    const { reply } = await run({ requiredTeamRole: 'LEAD' }, { teamRole: 'ENGINEER' });
    expect(reply.statusCode).toBe(403);
    expect((reply.body as { error: { message: string } }).error.message).toMatch(
      /LEAD role in this team/
    );
  });

  it('rejects an unknown capability when the hook is built', () => {
    expect(() => requireAuth({ capability: 'team.nope' as never })).toThrow(/unknown capability/);
    expect(() => requireAuth({ handlerChecked: ['nope.nope' as never] })).toThrow(
      /unknown capability/
    );
  });
});

describe('can() from a handler', () => {
  it('marks the request checked and caches the decision for the request', async () => {
    const { prisma, request } = makeRequest({ teamRole: 'LEAD' });
    request.user = { exp: 1, iat: 0, role: 'ENGINEER' as never, sub: 'u1' };
    const first = await can(request, 'team.templates.write', { teamId: TEAM });
    const second = await can(request, 'team.templates.write', { teamId: TEAM });
    expect(first).toEqual({ allowed: true, authority: 'team-role' });
    expect(second).toBe(first);
    expect(prisma.team.findMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a service principal', async () => {
    const { request } = makeRequest();
    (request as { principal?: unknown }).principal = { servicePrincipalId: 'sp1' };
    const decision = await can(request, 'team.launch', { teamId: TEAM });
    expect(decision).toMatchObject({ allowed: false, code: 'FORBIDDEN' });
  });
});

describe('the handler-checked backstop', () => {
  const reply = (statusCode: number) => ({ statusCode }) as unknown as FastifyReply;

  it('throws under test when a 2xx leaves with no check', async () => {
    const { request } = makeRequest();
    await expect(assertHandlerChecked(request, reply(200), 'ok')).rejects.toThrow(
      /handler-checked/
    );
  });

  it('is quiet once the handler asked, and for a refusal', async () => {
    const { request } = makeRequest({ teamRole: 'LEAD' });
    request.user = { exp: 1, iat: 0, role: 'ENGINEER' as never, sub: 'u1' };
    await can(request, 'team.templates.write', { teamId: TEAM });
    await expect(assertHandlerChecked(request, reply(200), 'ok')).resolves.toBe('ok');
    const { request: other } = makeRequest();
    await expect(assertHandlerChecked(other, reply(403), 'no')).resolves.toBe('no');
  });

  it('logs authz.unchecked instead of throwing outside test', async () => {
    const { request } = makeRequest();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(assertHandlerChecked(request, reply(200), 'ok')).resolves.toBe('ok');
      expect(request.log.error).toHaveBeenCalledWith(expect.anything(), 'authz.unchecked');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is attached to a handler-checked route only', () => {
    const route: { config: { authz: 'handler-checked' }; onSend?: unknown } = {
      config: { authz: 'handler-checked' },
    };
    appendHandlerCheckedBackstop(route);
    expect(route.onSend).toEqual([assertHandlerChecked]);
    const other: { config: { authz: 'capability' }; onSend?: unknown } = {
      config: { authz: 'capability' },
    };
    appendHandlerCheckedBackstop(other);
    expect(other.onSend).toBeUndefined();
  });
});

describe('route authz metadata', () => {
  const kind = (options: Parameters<typeof requireAuth>[0], config?: Record<string, unknown>) =>
    authzKindOf({ config, onRequest: requireAuth(options) });

  it('classifies each declaration', () => {
    expect(kind({ capability: 'team.read' })).toBe('capability');
    expect(kind({ handlerChecked: ['team.read'] })).toBe('handler-checked');
    expect(kind({}, { serviceScopes: ['runs:read'] })).toBe('service');
    expect(kind({ requiredRole: 'ADMIN' })).toBe('legacy');
    expect(kind({ requiredRole: 'ENGINEER' })).toBe('legacy');
    expect(kind({ requiredTeamRole: 'LEAD' })).toBe('legacy');
    expect(kind({})).toBe('authenticated');
  });

  it('is undefined with no requireAuth hook, and reads preHandler hooks too', () => {
    expect(authzKindOf({ onRequest: () => {} })).toBeUndefined();
    expect(authzKindOf({ preHandler: [requireAuth({ requiredRole: 'ADMIN' })] })).toBe('legacy');
  });

  it('writes config.authz and keeps a declared public', () => {
    const guarded: { config?: { authz?: AuthzKind }; onRequest: unknown } = {
      onRequest: requireAuth({ capability: 'team.read' }),
    };
    annotateAuthz(guarded);
    expect(guarded.config?.authz).toBe('capability');
    const open: { config: { authz: 'public' }; onRequest?: unknown } = {
      config: { authz: 'public' },
    };
    annotateAuthz(open);
    expect(open.config.authz).toBe('public');
  });

  it('refuses at registration a route with serviceScopes and a capability', () => {
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: requireAuth({ capability: 'team.launch' }),
        url: '/x',
      })
    ).toThrow(/capability team\.launch/);
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: requireAuth({ handlerChecked: ['team.launch'] }),
        url: '/x',
      })
    ).not.toThrow();
  });
});
