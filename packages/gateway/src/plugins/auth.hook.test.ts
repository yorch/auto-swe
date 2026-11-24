import type { FastifyReply, FastifyRequest } from 'fastify';
import jsonwebtoken from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from './auth.js';
import { assertServiceScopesAdmissible, requireAuth } from './auth.js';

/**
 * Exercises the pure/decidable authz surface of `plugins/auth.ts` directly —
 * the `requireAuth()` hook — without registering a Fastify app
 * or touching better-auth's session store. `requireAuth()` returns a plain
 * `(request, reply) => Promise<void>` hook, so it can be invoked against
 * minimal fake request/reply objects that only implement what the hook
 * actually reads: `headers.authorization`, `params`, `server.auth`,
 * `server.prisma`, and `log`.
 *
 * Deliberately NOT covered: the browser session-cookie path
 * (`verifyBetterAuthSession`). It lazily imports `../lib/betterAuth.js` and
 * `better-auth/node` and calls the real `getAuth().api.getSession()`, which
 * needs a live better-auth instance + DB — out of scope for a unit test per
 * the task brief ("do NOT try to exercise better-auth session init"). Every
 * test below sends a Bearer token so that path is never reached.
 */

// ─── fakes ──────────────────────────────────────────────────────────────────

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

interface RequestOpts {
  authorization?: string;
  params?: Record<string, string>;
  verifyAccessToken?: (token: string) => JwtPayload;
  hashToken?: (token: string) => string;
  prisma?: Record<string, unknown>;
  /** The route's `config`, as `request.routeOptions.config` carries it. */
  config?: Record<string, unknown>;
}

function makeRequest(opts: RequestOpts = {}): FastifyRequest {
  const auth = {
    hashToken: opts.hashToken ?? ((t: string) => `hash:${t}`),
    verifyAccessToken:
      opts.verifyAccessToken ??
      (() => {
        throw new Error('verifyAccessToken was not stubbed for this test');
      }),
  };
  const request = {
    headers: opts.authorization ? { authorization: opts.authorization } : {},
    log: { warn: vi.fn() },
    params: opts.params ?? {},
    routeOptions: { config: opts.config ?? {} },
    server: { auth, prisma: opts.prisma ?? {} },
  };
  return request as unknown as FastifyRequest;
}

function errorCode(reply: FakeReply): unknown {
  return (reply.body as { error?: { code?: unknown } } | undefined)?.error?.code;
}

const jwt = (role: string, sub = 'user-1'): JwtPayload => ({
  exp: 9_999_999_999,
  iat: 0,
  role: role as JwtPayload['role'],
  sub,
});

// ─── requireAuth: Bearer JWT path + platform capability ───────────────────

describe('requireAuth — Bearer JWT path', () => {
  it('lets the request through when the actor holds the capability (no reply sent)', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('ADMIN'),
    });
    const reply = makeReply();
    await requireAuth({ capability: 'platform.users.manage' })(
      request,
      reply as unknown as FastifyReply
    );

    expect(reply.statusCode).toBeUndefined();
    expect(request.user).toEqual(jwt('ADMIN'));
  });

  it('rejects with 403 FORBIDDEN naming the capability the actor lacks', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth({ capability: 'platform.users.manage' })(
      request,
      reply as unknown as FastifyReply
    );

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toMatchObject({
      error: { code: 'FORBIDDEN', missing: 'platform.users.manage' },
    });
  });

  it('rejects with 401 TOKEN_INVALID when verifyAccessToken throws (malformed/expired JWT)', async () => {
    const request = makeRequest({
      authorization: 'Bearer garbage',
      verifyAccessToken: () => {
        throw new Error('jwt malformed');
      },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_INVALID');
  });

  it('answers a bad signature with a fixed message, not the library text', async () => {
    const request = makeRequest({
      authorization: 'Bearer forged',
      verifyAccessToken: () => {
        throw new jsonwebtoken.JsonWebTokenError('invalid signature');
      },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: 'Invalid access token' },
    });
  });

  it('answers an expired JWT with 401 and a fixed expiry message', async () => {
    const request = makeRequest({
      authorization: 'Bearer stale',
      verifyAccessToken: () => {
        throw new jsonwebtoken.TokenExpiredError('jwt expired', new Date(0));
      },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: { code: 'TOKEN_INVALID', message: 'Access token expired' },
    });
  });

  it('never echoes the text of an unexpected error in a 401', async () => {
    const request = makeRequest({
      authorization: 'Bearer odd',
      verifyAccessToken: () => {
        throw new Error('relation "users" does not exist at db-internal:5432');
      },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({ error: { code: 'TOKEN_INVALID', message: 'Invalid token' } });
    expect(JSON.stringify(reply.body)).not.toContain('db-internal');
  });

  it('with no RBAC options, any successfully-verified token passes through', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
    expect(request.authMethod).toBe('jwt');
  });
});

// ─── requireAuth: PAT (ats_ prefix) path ───────────────────────────────────

describe('requireAuth — PAT (ats_ prefix) path', () => {
  it('routes an ats_-prefixed token through PAT hashing, not JWT verifyAccessToken', async () => {
    const verifyAccessToken = vi.fn();
    const findUnique = vi.fn().mockResolvedValue({
      expiresAt: null,
      id: 'pat-1',
      revokedAt: null,
      user: { id: 'user-9', isActive: true, role: 'ENGINEER' },
    });
    const update = vi.fn().mockResolvedValue({});
    const request = makeRequest({
      authorization: 'Bearer ats_abcdef123456',
      prisma: { apiToken: { findUnique, update } },
      verifyAccessToken,
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ user: true }),
        where: { tokenHash: 'hash:ats_abcdef123456' },
      })
    );
    expect(request.user).toMatchObject({ role: 'ENGINEER', sub: 'user-9' });
    expect(request.authMethod).toBe('pat');
    expect(reply.statusCode).toBeUndefined();
  });

  it('rejects an unknown token with 401 TOKEN_INVALID', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const request = makeRequest({
      authorization: 'Bearer ats_unknown',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_INVALID');
  });

  it('rejects a revoked token with 401 TOKEN_INVALID', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      expiresAt: null,
      revokedAt: new Date('2026-01-01'),
      user: { id: 'user-1', isActive: true, role: 'ENGINEER' },
    });
    const request = makeRequest({
      authorization: 'Bearer ats_revoked',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_INVALID');
  });

  it('rejects a token owned by an inactive user with 401 TOKEN_INVALID', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      expiresAt: null,
      revokedAt: null,
      user: { id: 'user-1', isActive: false, role: 'ENGINEER' },
    });
    const request = makeRequest({
      authorization: 'Bearer ats_inactive_user',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_INVALID');
  });

  it('surfaces a failed token lookup as a server error, not a 401', async () => {
    const findUnique = vi
      .fn()
      .mockRejectedValue(new Error('Timed out fetching a new connection from the pool'));
    const request = makeRequest({
      authorization: 'Bearer ats_during_outage',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();

    await expect(requireAuth()(request, reply as unknown as FastifyReply)).rejects.toMatchObject({
      name: 'ApiTokenLookupError',
    });
    // Nothing was sent: the rethrown error reaches the global handler, which
    // answers 500 with a generic message and logs the cause.
    expect(reply.statusCode).toBeUndefined();
    expect(reply.body).toBeUndefined();
  });

  it('surfaces a missing relation mid-deploy as a server error too', async () => {
    const findUnique = vi
      .fn()
      .mockRejectedValue(new Error('The table `public.api_tokens` does not exist'));
    const request = makeRequest({
      authorization: 'Bearer ats_mid_deploy',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();

    const failure = await requireAuth()(request, reply as unknown as FastifyReply).catch(
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Could not load this access token');
    expect(reply.statusCode).toBeUndefined();
  });

  it('rejects an expired token with 401 TOKEN_EXPIRED (distinct from TOKEN_INVALID)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() - 60_000),
      revokedAt: null,
      user: { id: 'user-1', isActive: true, role: 'ENGINEER' },
    });
    const request = makeRequest({
      authorization: 'Bearer ats_expired',
      prisma: { apiToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_EXPIRED');
  });
});

// ─── requireAuth: service principal tokens ─────────────────────────────────

describe('requireAuth — service principal tokens', () => {
  const SP_ID = '33333333-3333-4333-8333-333333333333';
  const TEAM_ID = '22222222-2222-4222-8222-222222222222';

  function serviceToken(
    over: {
      scopes?: string[];
      disabledAt?: Date | null;
      teamActive?: boolean;
      orgActive?: boolean;
      expiresAt?: Date | null;
      revokedAt?: Date | null;
    } = {}
  ) {
    return {
      expiresAt: 'expiresAt' in over ? over.expiresAt : new Date(Date.now() + 86_400_000),
      id: 'tok-1',
      revokedAt: over.revokedAt ?? null,
      scopes: over.scopes ?? ['runs:launch', 'runs:read'],
      servicePrincipal: {
        connectionIds: ['conn-1'],
        disabledAt: over.disabledAt ?? null,
        id: SP_ID,
        name: 'deployer',
        team: {
          isActive: over.teamActive ?? true,
          organization: { isActive: over.orgActive ?? true },
        },
        teamId: TEAM_ID,
        templateIds: [],
      },
      servicePrincipalId: SP_ID,
      user: null,
      userId: null,
    };
  }

  async function call(row: unknown, config: Record<string, unknown>, options = {}) {
    const request = makeRequest({
      authorization: 'Bearer ats_service',
      config,
      prisma: {
        apiToken: {
          findUnique: vi.fn().mockResolvedValue(row),
          update: vi.fn().mockResolvedValue({}),
        },
      },
    });
    const reply = makeReply();
    await requireAuth(options)(request, reply as unknown as FastifyReply);
    return { reply, request };
  }

  it('refuses a service token on a route that does not opt in: 401 SERVICE_TOKEN_NOT_ALLOWED', async () => {
    const { reply, request } = await call(serviceToken(), {});
    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    expect(request.user).toBeUndefined();
    expect(request.principal).toBeUndefined();
    expect(request.authMethod).toBeUndefined();
  });

  it('refuses it on an MCP-only route too: mcpScope is not an opt-in for machines', async () => {
    const { reply } = await call(serviceToken(), { mcpScope: 'read' });
    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('SERVICE_TOKEN_NOT_ALLOWED');
  });

  it('admits it on an opted-in route as request.principal, never request.user', async () => {
    const { reply, request } = await call(serviceToken(), { serviceScopes: ['runs:launch'] });
    expect(reply.statusCode).toBeUndefined();
    expect(request.user).toBeUndefined();
    expect(request.authMethod).toBe('service');
    expect(request.principal).toMatchObject({
      kind: 'service',
      scopes: ['runs:launch', 'runs:read'],
      servicePrincipalId: SP_ID,
      teamId: TEAM_ID,
    });
  });

  it('answers 403 INSUFFICIENT_SCOPE when the token lacks a scope the route declares', async () => {
    const { reply, request } = await call(serviceToken({ scopes: ['runs:read'] }), {
      serviceScopes: ['runs:cancel'],
    });
    expect(reply.statusCode).toBe(403);
    expect(errorCode(reply)).toBe('INSUFFICIENT_SCOPE');
    expect(request.principal).toBeUndefined();
  });

  it('ignores a stored scope this build does not know', async () => {
    const { reply } = await call(serviceToken({ scopes: ['admin:everything'] }), {
      serviceScopes: ['runs:launch'],
    });
    expect(reply.statusCode).toBe(403);
  });

  it.each([
    ['a disabled principal', { disabledAt: new Date() }, 'TOKEN_INVALID'],
    ['an inactive team', { teamActive: false }, 'TOKEN_INVALID'],
    ['an inactive organization', { orgActive: false }, 'TOKEN_INVALID'],
    ['a revoked token', { revokedAt: new Date() }, 'TOKEN_INVALID'],
    ['an expired token', { expiresAt: new Date(Date.now() - 1000) }, 'TOKEN_EXPIRED'],
    ['a token with no expiry', { expiresAt: null }, 'TOKEN_EXPIRED'],
  ])('refuses %s with 401 even on an opted-in route', async (_label, over, code) => {
    const { reply, request } = await call(serviceToken(over), { serviceScopes: ['runs:read'] });
    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe(code);
    expect(request.principal).toBeUndefined();
  });

  it('refuses a principal on a route that needs a team capability, which it cannot hold', async () => {
    const { reply } = await call(
      serviceToken(),
      { serviceScopes: ['runs:read'] },
      { capability: 'team.templates.write' }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('refuses a principal on a route that requires a platform capability', async () => {
    const { reply, request } = await call(
      serviceToken(),
      { serviceScopes: ['runs:read'] },
      { capability: 'platform.users.manage' }
    );
    expect(reply.statusCode).toBe(403);
    expect(request.principal).toBeUndefined();
  });

  it('refuses at registration a route that opts in behind a capability a principal cannot hold', () => {
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: requireAuth({ capability: 'platform.users.manage' }),
        url: '/x',
      })
    ).toThrow(/serviceScopes/);
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: [requireAuth({ capability: 'team.read' })],
        url: '/y',
      })
    ).toThrow();
    expect(() =>
      assertServiceScopesAdmissible({
        config: { serviceScopes: ['runs:read'] },
        onRequest: requireAuth(),
        url: '/z',
      })
    ).not.toThrow();
    // Without the opt-in there is nothing to check.
    expect(() =>
      assertServiceScopesAdmissible({
        onRequest: requireAuth({ capability: 'platform.users.manage' }),
      })
    ).not.toThrow();
  });

  it("leaves a person's token alone: scopes are ignored and the route needs no opt-in", async () => {
    const { reply, request } = await call(
      {
        expiresAt: null,
        id: 'pat-1',
        revokedAt: null,
        scopes: [],
        servicePrincipal: null,
        user: { id: 'user-9', isActive: true, role: 'ENGINEER' },
      },
      {}
    );
    expect(reply.statusCode).toBeUndefined();
    expect(request.user).toMatchObject({ sub: 'user-9' });
    expect(request.principal).toBeUndefined();
  });
});

// ─── requireAuth: team / org capability resolution ──────────────────────────
// Replaces the removed `requiredTeamRole` / `requiredOrgRole` blocks: the same membership,
// parameter-shape and bypass questions, asked through `capability`.

const TEAM_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000011';

function resolverPrisma(world: { teamRole?: string; orgRole?: string; teamExists?: boolean }) {
  return {
    organizationMembership: {
      findMany: vi.fn(async () => (world.orgRole ? [{ orgId: ORG_ID, role: world.orgRole }] : [])),
    },
    team: {
      findMany: vi.fn(async () =>
        world.teamExists === false ? [] : [{ id: TEAM_ID, isActive: true, orgId: ORG_ID }]
      ),
    },
    teamMembership: {
      findMany: vi.fn(async () =>
        world.teamRole
          ? [
              {
                role: world.teamRole,
                team: { id: TEAM_ID, isActive: true, orgId: ORG_ID },
                teamId: TEAM_ID,
              },
            ]
          : []
      ),
    },
  };
}

async function runCapability(
  options: Parameters<typeof requireAuth>[0],
  opts: { role?: string; params?: Record<string, string> } & Parameters<typeof resolverPrisma>[0]
) {
  const prisma = resolverPrisma(opts);
  const request = makeRequest({
    authorization: 'Bearer jwt',
    params: opts.params ?? {},
    prisma,
    verifyAccessToken: () => jwt(opts.role ?? 'ENGINEER', 'user-1'),
  });
  const reply = makeReply();
  await requireAuth(options)(request, reply as unknown as FastifyReply);
  return { prisma, reply, request };
}

describe('requireAuth — team capability', () => {
  it('platform ADMIN passes a team capability with no membership', async () => {
    const { reply } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: TEAM_ID }, role: 'ADMIN' }
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('fails loudly with 500 SERVER_ERROR when the team id route param is missing', async () => {
    const { reply, prisma } = await runCapability(
      { capability: 'team.templates.write' },
      { params: {} }
    );
    expect(reply.statusCode).toBe(500);
    expect(errorCode(reply)).toBe('SERVER_ERROR');
    expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
  });

  it('reads the default "id" param and allows a sufficient team role', async () => {
    const { reply, request } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: TEAM_ID }, teamRole: 'LEAD' }
    );
    expect(reply.statusCode).toBeUndefined();
    expect(request.teamRole).toBe('LEAD');
  });

  it('rejects with 403 when the membership role is insufficient', async () => {
    const { reply } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: TEAM_ID }, teamRole: 'MEMBER' }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 403 when there is no membership at all', async () => {
    const { reply } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: TEAM_ID } }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('an unrecognized stored team role holds nothing', async () => {
    const { reply } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: TEAM_ID }, teamRole: 'SOMETHING_WEIRD' }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 400 INVALID_ID when the team id param is not a UUID', async () => {
    const { reply, prisma } = await runCapability(
      { capability: 'team.templates.write' },
      { params: { id: 'not-a-uuid' } }
    );
    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ID');
    expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
  });

  it('honors a custom team parameter name', async () => {
    const { reply } = await runCapability(
      { capability: 'team.templates.write', team: { param: 'teamId' } },
      { params: { teamId: TEAM_ID }, teamRole: 'ADMIN' }
    );
    expect(reply.statusCode).toBeUndefined();
  });
});

describe('requireAuth — org capability', () => {
  it('platform ADMIN passes an org capability', async () => {
    const { reply } = await runCapability(
      { capability: 'org.settings.manage' },
      { params: { orgId: ORG_ID }, role: 'ADMIN' }
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('fails loudly with 500 SERVER_ERROR when the org id route param is missing', async () => {
    const { reply } = await runCapability({ capability: 'org.settings.manage' }, { params: {} });
    expect(reply.statusCode).toBe(500);
    expect(errorCode(reply)).toBe('SERVER_ERROR');
  });

  it('ORG_ADMIN holds an org governance capability; ORG_MEMBER does not', async () => {
    const ok = await runCapability(
      { capability: 'org.settings.manage' },
      { orgRole: 'ADMIN', params: { orgId: ORG_ID } }
    );
    expect(ok.reply.statusCode).toBeUndefined();
    const no = await runCapability(
      { capability: 'org.settings.manage' },
      { orgRole: 'MEMBER', params: { orgId: ORG_ID } }
    );
    expect(no.reply.statusCode).toBe(403);
  });

  it('an unrecognized org role holds nothing', async () => {
    const { reply } = await runCapability(
      { capability: 'org.settings.manage' },
      { orgRole: 'SOMETHING_WEIRD', params: { orgId: ORG_ID } }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 403 when there is no org membership at all', async () => {
    const { reply } = await runCapability(
      { capability: 'org.settings.manage' },
      { params: { orgId: ORG_ID } }
    );
    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 400 INVALID_ID when the org id param is not a UUID', async () => {
    const { reply } = await runCapability(
      { capability: 'org.settings.manage' },
      { params: { orgId: 'not-a-uuid' } }
    );
    expect(reply.statusCode).toBe(400);
    expect(errorCode(reply)).toBe('INVALID_ID');
  });

  it('honors a custom org parameter name', async () => {
    const { reply } = await runCapability(
      { capability: 'org.settings.manage', org: { param: 'organization' } },
      { orgRole: 'ADMIN', params: { organization: ORG_ID } }
    );
    expect(reply.statusCode).toBeUndefined();
  });
});

describe('requireAuth — platform capability short-circuits', () => {
  it('a platform capability failure never consults team or org membership', async () => {
    const { reply, prisma } = await runCapability(
      { capability: 'platform.users.manage' },
      { params: { id: TEAM_ID }, teamRole: 'ADMIN' }
    );
    expect(reply.statusCode).toBe(403);
    expect(errorCode(reply)).toBe('FORBIDDEN');
    expect(prisma.teamMembership.findMany).not.toHaveBeenCalled();
  });
});
