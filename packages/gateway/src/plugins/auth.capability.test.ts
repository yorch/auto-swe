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
  /** Whether the team row exists. Default true. */
  teamExists?: boolean;
  /** The route's declared `handlerChecked` keys, as `annotateAuthz` copies them to its config. */
  declared?: string[];
  params?: Record<string, string>;
}

function makeRequest(world: World = {}) {
  const prisma = {
    organizationMembership: {
      findMany: vi.fn(async () => (world.orgRole ? [{ orgId: ORG, role: world.orgRole }] : [])),
    },
    team: {
      findMany: vi.fn(async () =>
        world.teamExists === false ? [] : [{ id: TEAM, isActive: world.active ?? true, orgId: ORG }]
      ),
    },
    teamMembership: {
      findMany: vi.fn(async () =>
        world.teamRole
          ? [
              {
                role: world.teamRole,
                team: { id: TEAM, isActive: world.active ?? true, orgId: ORG },
                teamId: TEAM,
              },
            ]
          : []
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
    routeOptions: { config: { handlerChecked: world.declared ?? [] }, url: '/x/:id' },
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
    const { reply } = await run({ capability: 'team.templates.write' }, { teamRole: 'MEMBER' });
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
    const governance = await run({ capability: 'team.repos.manage' }, { orgRole: 'ADMIN' });
    expect(governance.reply.statusCode).toBeUndefined();
    expect(governance.request.authority).toBe('org-admin');
    const operation = await run({ capability: 'team.templates.write' }, { orgRole: 'ADMIN' });
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
      { orgRole: 'ADMIN', params: { orgId: ORG } }
    );
    expect(ok.reply.statusCode).toBeUndefined();
    const no = await run(
      { capability: 'org.settings.manage' },
      { orgRole: 'MEMBER', params: { orgId: ORG } }
    );
    expect(no.reply.statusCode).toBe(403);
  });

  it('a bare requireAuth() asks for no role: a team ENGINEER passes where a LEAD capability refuses', async () => {
    const bare = await run({}, { teamRole: 'MEMBER' });
    expect(bare.reply.statusCode).toBeUndefined();
    const guarded = await run({ capability: 'team.templates.write' }, { teamRole: 'MEMBER' });
    expect(guarded.reply.statusCode).toBe(403);
    expect((guarded.reply.body as { error: { missing: string } }).error.missing).toBe(
      'team.templates.write'
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
  const asUser = (request: FastifyRequest) => {
    request.user = { exp: 1, iat: 0, role: 'ENGINEER' as never, sub: 'u1' };
  };

  it('caches the decision for the request', async () => {
    const { prisma, request } = makeRequest({ teamRole: 'LEAD' });
    asUser(request);
    const first = await can(request, 'team.templates.write', { teamId: TEAM });
    const second = await can(request, 'team.templates.write', { teamId: TEAM });
    expect(first).toEqual({ allowed: true, authority: 'team-role' });
    expect(second).toBe(first);
    expect(prisma.team.findMany).toHaveBeenCalledTimes(1);
  });

  it('writes no request-wide authority or team role', async () => {
    const { request } = makeRequest({ orgRole: 'ADMIN', teamRole: 'LEAD' });
    asUser(request);
    await can(request, 'team.repos.manage', { teamId: TEAM });
    await can(request, 'team.templates.write', { teamId: TEAM });
    expect(request.authority).toBeUndefined();
    expect(request.teamRole).toBeUndefined();
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
  const asUser = (request: FastifyRequest) => {
    request.user = { exp: 1, iat: 0, role: 'ENGINEER' as never, sub: 'u1' };
  };

  it('throws under test when a 2xx leaves with no check', async () => {
    const { request } = makeRequest({ declared: ['team.templates.write'] });
    await expect(assertHandlerChecked(request, reply(200), 'ok')).rejects.toThrow(
      /handler-checked/
    );
  });

  it('is quiet once the handler asked and was allowed, and for a refusal', async () => {
    const { request } = makeRequest({ declared: ['team.templates.write'], teamRole: 'LEAD' });
    asUser(request);
    await can(request, 'team.templates.write', { teamId: TEAM });
    await expect(assertHandlerChecked(request, reply(200), 'ok')).resolves.toBe('ok');
    const { request: other } = makeRequest();
    await expect(assertHandlerChecked(other, reply(403), 'no')).resolves.toBe('no');
  });

  it('fires when the handler asked, was refused, ignored it and answered 200', async () => {
    const { request } = makeRequest({ declared: ['team.templates.write'], teamRole: 'MEMBER' });
    asUser(request);
    const decision = await can(request, 'team.templates.write', { teamId: TEAM });
    expect(decision.allowed).toBe(false);
    await expect(assertHandlerChecked(request, reply(200), 'ok')).rejects.toThrow(
      /handler-checked/
    );
  });

  it('does not count an allowed check of a capability the route did not declare', async () => {
    const { request } = makeRequest({ declared: ['team.templates.write'], teamRole: 'LEAD' });
    asUser(request);
    await can(request, 'team.launch', { teamId: TEAM });
    await expect(assertHandlerChecked(request, reply(200), 'ok')).rejects.toThrow(
      /handler-checked/
    );
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

  it('copies the declared keys to config.authz at registration', () => {
    const route: { config?: { handlerChecked?: readonly string[] }; onRequest: unknown } = {
      onRequest: requireAuth({ handlerChecked: ['team.templates.write', 'team.launch'] }),
    };
    annotateAuthz(route as never);
    expect(route.config?.handlerChecked).toEqual(['team.templates.write', 'team.launch']);
  });
});

describe('existence is not revealed', () => {
  it('answers a non-member the same for a team that exists and one that does not', async () => {
    const real = await run({ capability: 'team.templates.write' }, { teamRole: undefined });
    const missing = await run({ capability: 'team.templates.write' }, { teamExists: false });
    expect(real.reply.statusCode).toBe(403);
    expect(missing.reply.statusCode).toBe(403);
    expect(missing.reply.body).toEqual(real.reply.body);
  });

  it('answers 404 in both cases when the route hides existence', async () => {
    const opts = { capability: 'team.templates.write', hideAs404: true } as const;
    const real = await run(opts);
    const missing = await run(opts, { teamExists: false });
    expect(real.reply.statusCode).toBe(404);
    expect(missing.reply.statusCode).toBe(404);
    expect(missing.reply.body).toEqual(real.reply.body);
  });

  it('lets platform admin through on a team that does not exist, so the handler can 404', async () => {
    const { reply } = await run(
      { capability: 'team.secrets.manage' },
      { role: 'ADMIN', teamExists: false }
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('admits a lead through a platform capability that leads also hold', async () => {
    const lead = await run(
      { capability: 'platform.users.directory.read' },
      { params: {}, teamRole: 'LEAD' }
    );
    expect(lead.reply.statusCode).toBeUndefined();
    const member = await run(
      { capability: 'platform.users.directory.read' },
      { params: {}, teamRole: 'MEMBER' }
    );
    expect(member.reply.statusCode).toBe(403);
  });
});

describe('route authz metadata', () => {
  const kind = (options: Parameters<typeof requireAuth>[0], config?: Record<string, unknown>) =>
    authzKindOf({ config, onRequest: requireAuth(options) });

  it('classifies each declaration', () => {
    expect(kind({ capability: 'team.read' })).toBe('capability');
    expect(kind({ handlerChecked: ['team.read'] })).toBe('handler-checked');
    expect(kind({}, { serviceScopes: ['runs:read'] })).toBe('service');
    expect(kind({})).toBe('authenticated');
  });

  it('is undefined with no requireAuth hook, and reads preHandler hooks too', () => {
    expect(authzKindOf({ onRequest: () => {} })).toBeUndefined();
    expect(
      authzKindOf({ preHandler: [requireAuth({ capability: 'platform.users.manage' })] })
    ).toBe('capability');
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
    // A principal can never pass can(), so a handler-checked route may not admit one either.
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: requireAuth({ handlerChecked: ['team.launch'] }),
        url: '/x',
      })
    ).toThrow(/team\.launch/);
  });

  it('refuses at registration a capability or handlerChecked route that takes an orchestration token', () => {
    for (const options of [
      { capability: 'team.launch' },
      { handlerChecked: ['team.launch'] },
    ] as const) {
      expect(() =>
        assertServiceScopesAdmissible({
          config: { orchestrationToken: 'caller' },
          onRequest: requireAuth(options),
          url: '/o',
        })
      ).toThrow(/orchestration token/);
    }
    expect(() =>
      assertServiceScopesAdmissible({
        config: { orchestrationToken: 'caller' },
        onRequest: requireAuth(),
        url: '/o',
      })
    ).not.toThrow();
    // Also when the hook sits in preHandler.
    expect(() =>
      assertServiceScopesAdmissible({
        config: { orchestrationToken: 'caller' },
        preHandler: [requireAuth({ capability: 'team.launch' })],
        url: '/o',
      })
    ).toThrow();
  });
});
