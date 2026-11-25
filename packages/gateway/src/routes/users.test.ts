import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

// The /invite handler lazy-imports betterAuth.ts to fire a magic-link email.
// Mocking it avoids instantiating the real better-auth/PrismaClient wiring
// (which requires DATABASE_URL + BETTER_AUTH_SECRET at import) in a unit test.
// `signInMagicLinkMock` is declared via vi.hoisted so the same instance backs
// every call the mocked getAuth() factory returns — getAuth() is invoked
// fresh inside the route handler, so a non-hoisted mock would create a
// different (uninspectable) vi.fn() than the one this file asserts on.
const signInMagicLinkMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/betterAuth.js', () => ({
  getAuth: vi.fn(() => ({
    api: { signInMagicLink: signInMagicLinkMock },
  })),
}));

// The revocation itself is exercised against Postgres in lib/mcpGrants.pg.test.ts; here only
// the decision to call it matters.
const revokeMcpGrantsMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../lib/mcpGrants.js', () => ({ revokeMcpGrants: revokeMcpGrantsMock }));

import { _cacheSessionForTests, _hasCachedSessionForTests } from '../plugins/auth.js';
import { userRoutes } from './users.js';

interface AuthState {
  role: 'ADMIN' | 'USER';
  sub: string;
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authState: AuthState = { role: 'ADMIN', sub: 'admin-1' };

  const mockPrisma = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => [{ id }]),
    account: { create: vi.fn().mockResolvedValue({}) },
    configAuditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    organizationMembership: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'org-member' }),
    },
    session: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    team: {
      findUnique: vi.fn(),
    },
    teamJoinRequest: {
      updateManyAndReturn: vi.fn().mockResolvedValue([]),
    },
    teamMembership: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'team-member' }),
    },
    user: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  // The interactive transaction runs its callback against the same mock.
  Object.assign(mockPrisma, {
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
  });

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: authState.role,
      sub: authState.sub,
    }),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.ready();

  return { app, authState, mockPrisma };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };
// What the permissions loader reads for a person who leads one active team.
const LEADS_A_TEAM = [{ role: 'LEAD', team: { id: 'team-1', isActive: true, orgId: null } }];
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('userRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.authState.role = 'ADMIN';
    ctx.authState.sub = 'admin-1';
    ctx.mockPrisma.configAuditLog.create.mockReset();
    ctx.mockPrisma.team.findUnique.mockReset();
    ctx.mockPrisma.teamJoinRequest.updateManyAndReturn.mockReset().mockResolvedValue([]);
    ctx.mockPrisma.teamMembership.createMany.mockReset().mockResolvedValue({ count: 1 });
    // By default the caller leads a team, as the lookup requires of anyone who is not an ADMIN.
    ctx.mockPrisma.teamMembership.findMany.mockReset().mockResolvedValue(LEADS_A_TEAM);
    ctx.mockPrisma.organizationMembership.createMany.mockReset().mockResolvedValue({ count: 1 });
    ctx.mockPrisma.user.create.mockReset();
    ctx.mockPrisma.user.findFirst.mockReset();
    ctx.mockPrisma.user.findMany.mockReset();
    ctx.mockPrisma.user.findUnique.mockReset();
    ctx.mockPrisma.user.update.mockReset();
    signInMagicLinkMock.mockClear();
  });

  describe('GET /api/v1/users', () => {
    it('returns the user list for an ADMIN', async () => {
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        {
          createdAt: new Date('2026-01-01'),
          email: 'a@example.com',
          id: USER_ID,
          isActive: true,
          memberships: [{ role: 'LEAD', team: { id: 't-1', name: 'Platform', slug: 'platform' } }],
          role: 'USER',
          slackId: null,
        },
      ]);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ email: 'a@example.com', id: USER_ID });
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      ctx.authState.role = 'USER';

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
      expect(ctx.mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/v1/users/lookup', () => {
    it('resolves an active user by exact email for a LEAD', async () => {
      ctx.authState.role = 'USER';
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'a@example.com', id: USER_ID, name: 'Ada' },
      ]);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=A@example.com',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        email: 'a@example.com',
        id: USER_ID,
        name: 'Ada',
      });
      expect(ctx.mockPrisma.user.findMany).toHaveBeenCalledWith({
        // No `role`: the lookup must not tell a LEAD which addresses are admins.
        select: { email: true, id: true, name: true },
        take: 50,
        where: { email: { equals: 'A@example.com', mode: 'insensitive' }, isActive: true },
      });
    });

    it('does not answer for a row matched only by an ILIKE wildcard', async () => {
      ctx.authState.role = 'USER';
      // `_` is a one-character wildcard if the database compared with ILIKE.
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'ab@example.com', id: USER_ID, name: 'Ada' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=a_@example.com',
      });
      expect(res.statusCode).toBe(404);
    });

    it('is rate-limited per caller', async () => {
      const { default: rateLimit } = await import('@fastify/rate-limit');
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.decorate('prisma', {
        organizationMembership: { findMany: vi.fn().mockResolvedValue([]) },
        teamMembership: { findMany: vi.fn().mockResolvedValue(LEADS_A_TEAM) },
        user: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as never);
      app.decorate('auth', {
        verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'USER', sub: 'lead-1' }),
      } as unknown as never);
      // A global limit far above the route's, as in index.ts.
      await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
      await app.register(userRoutes, { prefix: '/api/v1/users' });
      await app.ready();
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
          const res = await app.inject({
            headers: AUTH_HEADER,
            method: 'GET',
            url: `/api/v1/users/lookup?email=u${i}@example.com`,
          });
          statuses.push(res.statusCode);
        }
        expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
        expect(statuses[30]).toBe(429);
      } finally {
        await app.close();
      }
    });

    it('returns 404 when no active user matches', async () => {
      ctx.authState.role = 'USER';
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=nobody@example.com',
      });
      expect(res.statusCode).toBe(404);
    });

    it('resolves an email for a platform USER who leads a team', async () => {
      ctx.authState.role = 'USER';
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'a@example.com', id: USER_ID, name: 'Ada' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=a@example.com',
      });
      expect(res.statusCode).toBe(200);
    });

    it.each(['USER'] as const)(
      'refuses a platform %s who leads no team, and looks nobody up',
      async (role) => {
        ctx.authState.role = role;
        ctx.mockPrisma.teamMembership.findMany.mockResolvedValue([]);
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'GET',
          url: '/api/v1/users/lookup?email=a@example.com',
        });
        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
        expect(ctx.mockPrisma.user.findMany).not.toHaveBeenCalled();
      }
    );

    it('holds the directory capability only through an active team', async () => {
      ctx.authState.role = 'USER';
      ctx.authState.sub = 'user-9';
      ctx.mockPrisma.teamMembership.findMany.mockResolvedValue([
        { role: 'ADMIN', team: { id: 'team-2', isActive: false, orgId: null } },
      ]);
      const refused = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=a@example.com',
      });
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.payload).error.missing).toBe('platform.users.directory.read');
      expect(ctx.mockPrisma.teamMembership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-9' } })
      );
    });

    it('lets a lead of an active team look up', async () => {
      ctx.authState.role = 'USER';
      ctx.authState.sub = 'user-9';
      ctx.mockPrisma.teamMembership.findMany.mockResolvedValue([
        { role: 'ADMIN', team: { id: 'team-2', isActive: true, orgId: null } },
      ]);
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([]);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=a@example.com',
      });
      expect(res.statusCode).toBe(404);
    });

    it('lets a platform ADMIN look up without leading any team', async () => {
      ctx.authState.role = 'ADMIN';
      ctx.mockPrisma.teamMembership.findMany.mockResolvedValue([]);
      ctx.mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'a@example.com', id: USER_ID, name: 'Ada' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=a@example.com',
      });
      expect(res.statusCode).toBe(200);
    });

    it('rejects a malformed email', async () => {
      ctx.authState.role = 'USER';
      const bad = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/users/lookup?email=not-an-email',
      });
      expect(bad.statusCode).toBe(400);
      expect(ctx.mockPrisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/users', () => {
    it('creates a user and returns a generated temporaryPassword when none was given', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null); // email pre-check
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'new@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'new@example.com' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data.email).toBe('new@example.com');
      expect(typeof body.data.temporaryPassword).toBe('string');
      expect(body.data.temporaryPassword.length).toBeGreaterThan(0);
    });

    it('creates a verified user with a better-auth credential account for the password', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'cred@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });
      ctx.mockPrisma.account.create.mockClear();

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'cred@example.com', password: 'supersecret1' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.user.create.mock.calls[0]?.[0].data.emailVerified).toBe(true);
      const data = ctx.mockPrisma.account.create.mock.calls[0]?.[0].data;
      expect(data).toMatchObject({ accountId: USER_ID, providerId: 'credential', userId: USER_ID });
      // The stored hash is better-auth's own, so its verifier accepts the password.
      const { verifyPassword } = await import('better-auth/crypto');
      expect(await verifyPassword({ hash: data.password, password: 'supersecret1' })).toBe(true);
    });

    it('stores a mixed-case, padded email trimmed and lower-cased and checks case-insensitively', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'mixed@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: '  Mixed@Example.COM ' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { email: { equals: 'mixed@example.com', mode: 'insensitive' } },
      });
      expect(ctx.mockPrisma.user.create.mock.calls[0]?.[0].data.email).toBe('mixed@example.com');
    });

    it('rejects a password longer than better-auth accepts', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'long@example.com', password: 'x'.repeat(129) },
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('omits temporaryPassword when a password was supplied', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'withpw@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'withpw@example.com', password: 'supersecret1' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data).not.toHaveProperty('temporaryPassword');
    });

    it('returns 409 USER_EXISTS when the email pre-check finds a match', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'existing' });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'dup@example.com' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('USER_EXISTS');
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('returns 409 SLACK_ID_TAKEN when the slackId pre-check finds a match', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'other-user' });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'new2@example.com', slackId: 'U123' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SLACK_ID_TAKEN');
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('maps a concurrent P2002 on email to 409 USER_EXISTS (race past the pre-check)', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['email'] },
        })
      );

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'race@example.com' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('USER_EXISTS');
    });

    it('maps a concurrent P2002 on slackId to 409 SLACK_ID_TAKEN (race past the pre-check)', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['slackId'] },
        })
      );

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'race2@example.com', slackId: 'U999' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SLACK_ID_TAKEN');
    });

    it('returns 400 for an invalid email', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'not-an-email' },
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns 400 for a password shorter than 8 characters', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'short@example.com', password: 'short' },
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an invalid role', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'badrole@example.com', role: 'SUPERUSER' },
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for an empty-string slackId (truthiness-guard bypass attempt)', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'emptyslack@example.com', slackId: '' },
        url: '/api/v1/users',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      ctx.authState.role = 'USER';

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'blocked@example.com' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/users/invite', () => {
    it('creates a pre-active user, attaches the default team, and fires a magic link', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'invitee@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({
        id: 'team-default',
        orgId: 'org-default',
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'invitee@example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.data).toEqual({
        email: 'invitee@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
      });
      expect(ctx.mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ emailVerified: true, isActive: true }),
        })
      );
      expect(ctx.mockPrisma.teamMembership.createMany).toHaveBeenCalledWith({
        data: { role: 'MEMBER', teamId: 'team-default', userId: USER_ID },
        skipDuplicates: true,
      });
      expect(ctx.mockPrisma.organizationMembership.createMany).toHaveBeenCalledWith({
        data: { orgId: 'org-default', role: 'MEMBER', userId: USER_ID },
        skipDuplicates: true,
      });
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ actorId: 'admin-1', entityType: 'OrganizationMembership' }),
      });
      expect(signInMagicLinkMock).toHaveBeenCalled();
    });

    it('still succeeds (201) when the default team row is missing', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'noteam@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'noteam@example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.teamMembership.createMany).not.toHaveBeenCalled();
      expect(ctx.mockPrisma.organizationMembership.createMany).not.toHaveBeenCalled();
    });

    it('lower-cases the invited email before storing it', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'invitee@example.com',
        emailVerified: true,
        id: USER_ID,
        isActive: true,
        role: 'USER',
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'Invitee@Example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.user.create.mock.calls[0]?.[0].data.email).toBe('invitee@example.com');
    });

    it('returns 409 USER_EXISTS when the email already exists', async () => {
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'existing' });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'dup@example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('USER_EXISTS');
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid email', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'nope' },
        url: '/api/v1/users/invite',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      ctx.authState.role = 'USER';

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'blocked@example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/v1/users/:id', () => {
    it('updates the user and returns the new row', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({
        email: 'updated@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'ADMIN' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.role).toBe('ADMIN');
    });

    it('returns 404 when the user does not exist', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'USER' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error.code).toBe('USER_NOT_FOUND');
      expect(ctx.mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('returns 409 SLACK_ID_TAKEN when reassigning to a slackId held by another user', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce({ id: 'other-user' });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { slackId: 'U123' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SLACK_ID_TAKEN');
      expect(ctx.mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('maps a concurrent P2002 on update to the right 409', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
      ctx.mockPrisma.user.findFirst.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.update.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['slackId'] },
        })
      );

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { slackId: 'U456' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('SLACK_ID_TAKEN');
    });

    it('returns 400 for a malformed :id param', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'USER' },
        url: '/api/v1/users/not-a-uuid',
      });
      expect(res.statusCode).toBe(400);
      expect(ctx.mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid role in the body', async () => {
      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'SUPERUSER' },
        url: `/api/v1/users/${USER_ID}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 403 for a non-ADMIN caller', async () => {
      ctx.authState.role = 'USER';

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'ADMIN' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(403);
      expect(ctx.mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    describe('admin self-mutation guard', () => {
      it('returns 400 CANNOT_SELF_DEACTIVATE when an admin deactivates their own account', async () => {
        ctx.authState.sub = USER_ID;
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error.code).toBe('CANNOT_SELF_DEACTIVATE');
        expect(ctx.mockPrisma.user.update).not.toHaveBeenCalled();
      });

      it('returns 400 CANNOT_SELF_DEMOTE when an admin removes their own admin role', async () => {
        ctx.authState.sub = USER_ID;
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'USER' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error.code).toBe('CANNOT_SELF_DEMOTE');
        expect(ctx.mockPrisma.user.update).not.toHaveBeenCalled();
      });

      it('allows an admin to re-affirm their own ADMIN role', async () => {
        ctx.authState.sub = USER_ID;
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'admin@example.com',
          id: USER_ID,
          isActive: true,
          role: 'ADMIN',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'ADMIN' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.user.update).toHaveBeenCalled();
      });

      it('allows an admin to edit their own email', async () => {
        ctx.authState.sub = USER_ID;
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'new@x.com',
          id: USER_ID,
          isActive: true,
          role: 'ADMIN',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { email: 'new@x.com' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.user.update).toHaveBeenCalled();
      });

      it('allows an admin to deactivate a different user', async () => {
        ctx.authState.sub = 'admin-1';
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.user.update).toHaveBeenCalled();
      });

      it('drops the deactivated user’s cached browser sessions immediately', async () => {
        // The cache is keyed by the signed cookie value (`<token>.<sig>`), which
        // the sessions table never stores — invalidation keys on the user id.
        const payload = { exp: 0, iat: 0, role: 'USER' as const, sub: USER_ID };
        _cacheSessionForTests('tok-a.sig-a', payload);
        _cacheSessionForTests('tok-other.sig', { ...payload, sub: 'someone-else' });
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(_hasCachedSessionForTests('tok-a.sig-a')).toBe(false);
        expect(_hasCachedSessionForTests('tok-other.sig')).toBe(true);
      });

      it('revokes every MCP grant of a user it deactivates, attributed to the admin', async () => {
        revokeMcpGrantsMock.mockClear();
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        // Inside the same transaction as the update (the mock's transaction client is the mock).
        expect(revokeMcpGrantsMock).toHaveBeenCalledWith(ctx.mockPrisma, {
          actorId: 'admin-1',
          userId: USER_ID,
        });
      });

      it('closes the deactivated user’s open join requests in the same transaction, audited', async () => {
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });
        const closed = {
          closeReason: 'REQUESTER_DEACTIVATED',
          grantedRole: null,
          id: 'jr-1',
          requiresOrgApproval: false,
          status: 'WITHDRAWN',
          teamId: 'team-1',
          userId: USER_ID,
        };
        ctx.mockPrisma.teamJoinRequest.updateManyAndReturn
          .mockResolvedValueOnce([closed])
          .mockResolvedValueOnce([]);

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        const calls = ctx.mockPrisma.teamJoinRequest.updateManyAndReturn.mock
          .calls as unknown as Array<
          [{ data: Record<string, unknown>; where: Record<string, unknown> }]
        >;
        expect(calls.map(([arg]) => arg.where)).toEqual([
          { status: 'PENDING_TEAM', userId: USER_ID },
          { status: 'PENDING_ORG', userId: USER_ID },
        ]);
        expect(calls[0]?.[0].data).toMatchObject({
          closeReason: 'REQUESTER_DEACTIVATED',
          status: 'WITHDRAWN',
          teamDecisionNote: 'Closed automatically: the requester was deactivated.',
        });
        const entities = ctx.mockPrisma.configAuditLog.create.mock.calls.map(
          ([arg]) => (arg as { data: { entityId: string; entityType: string } }).data
        );
        expect(entities).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entityId: 'jr-1', entityType: 'TeamJoinRequest' }),
          ])
        );
      });

      it('takes the join-request lock of the deactivated user before it closes anything', async () => {
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });
        const order: string[] = [];
        const raw = ctx.mockPrisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
        raw.mockClear();
        raw.mockImplementation(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          order.push(`lock:${values.join(',')}`);
          return 1;
        });
        (ctx.mockPrisma.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
          async (strings: TemplateStringsArray, id: string) => {
            order.push(`row:${strings.join('?').includes('FROM users') ? 'user' : 'other'}:${id}`);
            return [{ id }];
          }
        );
        ctx.mockPrisma.teamJoinRequest.updateManyAndReturn.mockImplementation(async () => {
          order.push('close');
          return [];
        });
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });
        expect(res.statusCode).toBe(200);
        // The key is the one `createJoinRequest` takes, taken before the first close, then the
        // account's own row (the lock order of `lib/lockOrder.ts`: the user row before request rows).
        expect(order[0]).toBe(`lock:join-request:${USER_ID}`);
        expect(order[1]).toBe(`row:user:${USER_ID}`);
        expect(order.indexOf('close')).toBeGreaterThan(1);
        ctx.mockPrisma.teamJoinRequest.updateManyAndReturn.mockReset();
        ctx.mockPrisma.teamJoinRequest.updateManyAndReturn.mockResolvedValue([]);
      });

      it('closes nothing when the update does not deactivate anyone', async () => {
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: true,
          role: 'USER',
          slackId: null,
        });
        await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'USER' },
          url: `/api/v1/users/${USER_ID}`,
        });
        expect(ctx.mockPrisma.teamJoinRequest.updateManyAndReturn).not.toHaveBeenCalled();
      });

      it('leaves MCP grants alone when the update does not deactivate anyone', async () => {
        revokeMcpGrantsMock.mockClear();
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: true,
          role: 'USER',
          slackId: null,
        });
        await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'USER' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(revokeMcpGrantsMock).not.toHaveBeenCalled();
      });

      it('revokes again when an already inactive user is deactivated again, so a retry heals a failure', async () => {
        revokeMcpGrantsMock.mockClear();
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: false });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(revokeMcpGrantsMock).toHaveBeenCalledTimes(1);
      });

      it('fails the request, and writes no user audit row, when the revocation fails', async () => {
        revokeMcpGrantsMock.mockClear().mockRejectedValueOnce(new Error('db down'));
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID, isActive: true });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: false,
          role: 'USER',
          slackId: null,
        });
        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { isActive: false },
          url: `/api/v1/users/${USER_ID}`,
        });

        // The real transaction rolls the update back with the failure.
        expect(res.statusCode).toBe(500);
        expect(ctx.mockPrisma.configAuditLog.create).not.toHaveBeenCalled();
      });

      it('allows an admin to demote a different user', async () => {
        ctx.authState.sub = 'admin-1';
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: true,
          role: 'USER',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'USER' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.user.update).toHaveBeenCalled();
      });
    });
  });

  describe('audit logging', () => {
    it('POST / writes a CREATE audit entry without password hash or plaintext password', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'audit@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'audit@example.com', password: 'hunter2-secret' },
        url: '/api/v1/users',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.configAuditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('hunter2-secret');
      expect(serialized).not.toContain('passwordHash');
      expect(auditCall?.data).toMatchObject({
        action: 'CREATE',
        actorId: 'admin-1',
        entityId: USER_ID,
        entityType: 'User',
      });
      expect(auditCall?.data.afterJson.email).toBe('audit@example.com');
    });

    it('POST /invite writes a CREATE audit entry with safe fields', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'invite-audit@example.com',
        emailVerified: true,
        id: USER_ID,
        isActive: true,
        role: 'USER',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce(null);

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'invite-audit@example.com', role: 'USER' },
        url: '/api/v1/users/invite',
      });

      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
      expect(auditCall?.data).toMatchObject({
        action: 'CREATE',
        entityType: 'User',
      });
      expect(auditCall?.data.afterJson).toMatchObject({
        email: 'invite-audit@example.com',
        emailVerified: true,
        isActive: true,
        role: 'USER',
      });
    });

    it('PATCH /:id writes an UPDATE audit entry with before and after snapshots', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'before@example.com',
        id: USER_ID,
        isActive: true,
        role: 'USER',
        slackId: null,
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({
        email: 'before@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ADMIN',
        slackId: null,
      });

      await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'ADMIN' },
        url: `/api/v1/users/${USER_ID}`,
      });

      const auditCall = ctx.mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('passwordHash');
      expect(auditCall?.data).toMatchObject({
        action: 'UPDATE',
        entityType: 'User',
      });
      expect(auditCall?.data.beforeJson).toMatchObject({ role: 'USER' });
      expect(auditCall?.data.afterJson).toMatchObject({ role: 'ADMIN' });
    });
  });
});
