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

import { userRoutes } from './users.js';

interface AuthState {
  role: 'ADMIN' | 'LEAD' | 'ENGINEER';
  sub: string;
}

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authState: AuthState = { role: 'ADMIN', sub: 'admin-1' };

  const mockPrisma = {
    team: {
      findUnique: vi.fn(),
    },
    teamMembership: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    user: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };

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
    ctx.mockPrisma.team.findUnique.mockReset();
    ctx.mockPrisma.teamMembership.upsert.mockReset().mockResolvedValue({});
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
          role: 'ENGINEER',
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
      ctx.authState.role = 'LEAD';

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

  describe('POST /api/v1/users', () => {
    it('creates a user and returns a generated temporaryPassword when none was given', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null); // email pre-check
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'new@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ENGINEER',
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

    it('omits temporaryPassword when a password was supplied', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        createdAt: new Date('2026-01-01'),
        email: 'withpw@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ENGINEER',
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
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'existing' });

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
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
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
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
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
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
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
      expect(ctx.mockPrisma.user.findUnique).not.toHaveBeenCalled();
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
      ctx.authState.role = 'LEAD';

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
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'invitee@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ENGINEER',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce({ id: 'team-default' });

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
        role: 'ENGINEER',
      });
      expect(ctx.mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ emailVerified: true, isActive: true }),
        })
      );
      expect(ctx.mockPrisma.teamMembership.upsert).toHaveBeenCalled();
      expect(signInMagicLinkMock).toHaveBeenCalled();
    });

    it('still succeeds (201) when the default team row is missing', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      ctx.mockPrisma.user.create.mockResolvedValueOnce({
        email: 'noteam@example.com',
        id: USER_ID,
        isActive: true,
        role: 'ENGINEER',
      });
      ctx.mockPrisma.team.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'POST',
        payload: { email: 'noteam@example.com' },
        url: '/api/v1/users/invite',
      });

      expect(res.statusCode).toBe(201);
      expect(ctx.mockPrisma.teamMembership.upsert).not.toHaveBeenCalled();
    });

    it('returns 409 USER_EXISTS when the email already exists', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'existing' });

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
      ctx.authState.role = 'ENGINEER';

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
        role: 'LEAD',
        slackId: null,
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'LEAD' },
        url: `/api/v1/users/${USER_ID}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.role).toBe('LEAD');
    });

    it('returns 404 when the user does not exist', async () => {
      ctx.mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { role: 'LEAD' },
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
        payload: { role: 'LEAD' },
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
      ctx.authState.role = 'LEAD';

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
          payload: { role: 'ENGINEER' },
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
          role: 'ENGINEER',
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

      it('allows an admin to demote a different user', async () => {
        ctx.authState.sub = 'admin-1';
        ctx.mockPrisma.user.findUnique.mockResolvedValueOnce({ id: USER_ID });
        ctx.mockPrisma.user.update.mockResolvedValueOnce({
          email: 'other@example.com',
          id: USER_ID,
          isActive: true,
          role: 'ENGINEER',
          slackId: null,
        });

        const res = await ctx.app.inject({
          headers: AUTH_HEADER,
          method: 'PATCH',
          payload: { role: 'ENGINEER' },
          url: `/api/v1/users/${USER_ID}`,
        });

        expect(res.statusCode).toBe(200);
        expect(ctx.mockPrisma.user.update).toHaveBeenCalled();
      });
    });
  });
});
