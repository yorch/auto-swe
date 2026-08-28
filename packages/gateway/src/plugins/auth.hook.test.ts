import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from './auth.js';
import { hasRole, requireAuth } from './auth.js';

/**
 * Exercises the pure/decidable authz surface of `plugins/auth.ts` directly —
 * `hasRole` plus the `requireAuth()` hook — without registering a Fastify app
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

// ─── hasRole hierarchy ──────────────────────────────────────────────────────

describe('hasRole', () => {
  it('ADMIN outranks LEAD and ENGINEER (and itself)', () => {
    expect(hasRole('ADMIN', 'ADMIN')).toBe(true);
    expect(hasRole('ADMIN', 'LEAD')).toBe(true);
    expect(hasRole('ADMIN', 'ENGINEER')).toBe(true);
  });

  it('LEAD outranks ENGINEER and itself, but not ADMIN', () => {
    expect(hasRole('LEAD', 'LEAD')).toBe(true);
    expect(hasRole('LEAD', 'ENGINEER')).toBe(true);
    expect(hasRole('LEAD', 'ADMIN')).toBe(false);
  });

  it('ENGINEER only satisfies ENGINEER', () => {
    expect(hasRole('ENGINEER', 'ENGINEER')).toBe(true);
    expect(hasRole('ENGINEER', 'LEAD')).toBe(false);
    expect(hasRole('ENGINEER', 'ADMIN')).toBe(false);
  });

  it('an unrecognized role is treated as rank 0 — denied against any known required role', () => {
    expect(hasRole('BOGUS', 'ENGINEER')).toBe(false);
    expect(hasRole('BOGUS', 'LEAD')).toBe(false);
    expect(hasRole('BOGUS', 'ADMIN')).toBe(false);
  });
});

// ─── requireAuth: Bearer JWT path + platform requiredRole ─────────────────

describe('requireAuth — Bearer JWT path', () => {
  it('lets the request through when the role satisfies requiredRole (no reply sent)', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('LEAD'),
    });
    const reply = makeReply();
    await requireAuth({ requiredRole: 'ENGINEER' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
    expect(request.user).toEqual(jwt('LEAD'));
  });

  it('rejects with 403 FORBIDDEN when the role does not satisfy requiredRole', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth({ requiredRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'Requires LEAD role' },
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

  it('with no RBAC options, any successfully-verified token passes through', async () => {
    const request = makeRequest({
      authorization: 'Bearer good-jwt',
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
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
      prisma: { personalAccessToken: { findUnique, update } },
      verifyAccessToken,
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      include: { user: true },
      where: { tokenHash: 'hash:ats_abcdef123456' },
    });
    expect(request.user).toMatchObject({ role: 'ENGINEER', sub: 'user-9' });
    expect(reply.statusCode).toBeUndefined();
  });

  it('rejects an unknown token with 401 TOKEN_INVALID', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const request = makeRequest({
      authorization: 'Bearer ats_unknown',
      prisma: { personalAccessToken: { findUnique } },
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
      prisma: { personalAccessToken: { findUnique } },
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
      prisma: { personalAccessToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_INVALID');
  });

  it('rejects an expired token with 401 TOKEN_EXPIRED (distinct from TOKEN_INVALID)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() - 60_000),
      revokedAt: null,
      user: { id: 'user-1', isActive: true, role: 'ENGINEER' },
    });
    const request = makeRequest({
      authorization: 'Bearer ats_expired',
      prisma: { personalAccessToken: { findUnique } },
    });
    const reply = makeReply();
    await requireAuth()(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(errorCode(reply)).toBe('TOKEN_EXPIRED');
  });
});

// ─── requireAuth: requiredTeamRole ──────────────────────────────────────────

describe('requireAuth — requiredTeamRole', () => {
  it('platform ADMIN bypasses team-membership resolution entirely (no DB lookup)', async () => {
    const findUnique = vi.fn();
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: {}, // no team id param — still bypassed for a platform ADMIN
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ADMIN', 'admin-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails loudly with 500 SERVER_ERROR when the team id route param is missing (not a silent grant)', async () => {
    const findUnique = vi.fn();
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: {},
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(500);
    expect(errorCode(reply)).toBe('SERVER_ERROR');
    // Critical: the DB was never even consulted, so this cannot be confused
    // with a legitimate "no membership" 403.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('resolves membership via the default "id" param and allows a sufficient team role', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'LEAD' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { id: '00000000-0000-0000-0000-000000000001' },
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        userId_teamId: { teamId: '00000000-0000-0000-0000-000000000001', userId: 'user-1' },
      },
    });
    expect(request.teamRole).toBe('LEAD');
  });

  it('rejects with 403 when the membership role is insufficient', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'ENGINEER' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { id: '00000000-0000-0000-0000-000000000001' },
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 403 when there is no membership row at all', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { id: '00000000-0000-0000-0000-000000000001' },
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
  });

  it('honors a custom teamIdParam name', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { teamId: '00000000-0000-0000-0000-000000000002' },
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredTeamRole: 'LEAD', teamIdParam: 'teamId' })(
      request,
      reply as unknown as FastifyReply
    );

    expect(reply.statusCode).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        userId_teamId: { teamId: '00000000-0000-0000-0000-000000000002', userId: 'user-1' },
      },
    });
  });
});

// ─── requireAuth: requiredOrgRole ───────────────────────────────────────────

describe('requireAuth — requiredOrgRole', () => {
  it('platform ADMIN bypasses org-membership resolution entirely (no DB lookup)', async () => {
    const findUnique = vi.fn();
    const request = makeRequest({
      authorization: 'Bearer jwt',
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ADMIN', 'admin-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_ADMIN' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails loudly with 500 SERVER_ERROR when the org id route param is missing', async () => {
    const findUnique = vi.fn();
    const request = makeRequest({
      authorization: 'Bearer jwt',
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_MEMBER' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(500);
    expect(errorCode(reply)).toBe('SERVER_ERROR');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('ORG_ADMIN satisfies a requiredOrgRole of ORG_MEMBER (hierarchy)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'ORG_ADMIN' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { orgId: '00000000-0000-0000-0000-000000000011' },
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_MEMBER' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBeUndefined();
  });

  it('ORG_MEMBER does NOT satisfy a requiredOrgRole of ORG_ADMIN (hierarchy)', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'ORG_MEMBER' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { orgId: '00000000-0000-0000-0000-000000000011' },
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_ADMIN' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
  });

  it('an unrecognized membership role is treated as rank 0 — always denied', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'SOMETHING_WEIRD' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { orgId: '00000000-0000-0000-0000-000000000011' },
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_MEMBER' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
  });

  it('rejects with 403 when there is no org membership row at all', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { orgId: '00000000-0000-0000-0000-000000000011' },
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredOrgRole: 'ORG_MEMBER' })(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(403);
  });

  it('honors a custom orgIdParam name', async () => {
    const findUnique = vi.fn().mockResolvedValue({ role: 'ORG_ADMIN' });
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { organization: '00000000-0000-0000-0000-000000000019' },
      prisma: { organizationMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ orgIdParam: 'organization', requiredOrgRole: 'ORG_MEMBER' })(
      request,
      reply as unknown as FastifyReply
    );

    expect(reply.statusCode).toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_orgId: { orgId: '00000000-0000-0000-0000-000000000019', userId: 'user-1' } },
    });
  });
});

// ─── requireAuth: combined checks ───────────────────────────────────────────

describe('requireAuth — requiredRole is checked before team/org checks', () => {
  it('a platform-role failure short-circuits before any team/org DB lookup', async () => {
    const findUnique = vi.fn();
    const request = makeRequest({
      authorization: 'Bearer jwt',
      params: { id: '00000000-0000-0000-0000-000000000001' },
      prisma: { teamMembership: { findUnique } },
      verifyAccessToken: () => jwt('ENGINEER', 'user-1'),
    });
    const reply = makeReply();
    await requireAuth({ requiredRole: 'ADMIN', requiredTeamRole: 'LEAD' })(
      request,
      reply as unknown as FastifyReply
    );

    expect(reply.statusCode).toBe(403);
    expect(errorCode(reply)).toBe('FORBIDDEN');
    expect(findUnique).not.toHaveBeenCalled();
  });
});
