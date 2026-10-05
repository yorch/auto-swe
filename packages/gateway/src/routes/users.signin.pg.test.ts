import { prisma } from '@auto-swe/shared/db';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initAuth } from '../lib/betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from '../lib/betterAuthHandler.js';
import { registerFormBodyParser } from '../lib/formBody.js';
import { ipRateLimitKey } from '../plugins/auth.js';
import { userRoutes } from './users.js';

/**
 * An admin-created user signs in with a password, through the real better-auth handler and the
 * Prisma adapter. better-auth looks an account up by the lower-cased email, so an address stored
 * as typed would create an account nobody can sign in to; the route and the sign-in must agree.
 *
 * Opt in with `USER_SIGNIN_PG_TEST=1` and a `DATABASE_URL` for a throwaway database that
 * `prisma migrate deploy` has been run against (it creates and deletes rows).
 */
const enabled = process.env.USER_SIGNIN_PG_TEST === '1';

const HOST = 'localhost:8080';
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';
const SUFFIX = '@signin-pg.example.test';

describe.skipIf(!enabled)('admin-created users sign in with a password', () => {
  let app: FastifyInstance;
  let adminId: string;
  let seq = 0;

  const signIn = (email: string, password = PASSWORD) =>
    app.inject({
      headers: { host: HOST, origin: ORIGIN },
      method: 'POST',
      payload: { email, password },
      remoteAddress: `198.51.100.${(seq++ % 250) + 1}`,
      url: '/api/auth/sign-in/email',
    });

  const createUser = (payload: Record<string, unknown>) =>
    app.inject({
      headers: { authorization: 'Bearer admin' },
      method: 'POST',
      payload,
      url: '/api/v1/users',
    });

  beforeAll(async () => {
    await initAuth();
    const admin = await prisma.user.create({
      data: {
        email: `admin${SUFFIX}`,
        emailVerified: true,
        isActive: true,
        name: 'Admin',
        role: 'ADMIN',
      },
    });
    adminId = admin.id;
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerFormBodyParser(app);
    await app.register(rateLimit, {
      keyGenerator: ipRateLimitKey,
      max: 10_000,
      timeWindow: '1 minute',
    });
    app.decorate('prisma', prisma as never);
    // The route's own authentication is not under test: every bearer is the admin.
    app.decorate('auth', {
      verifyAccessToken: async () => ({ exp: 9999999999, iat: 0, role: 'ADMIN', sub: adminId }),
    } as never);
    await app.register(userRoutes, { prefix: '/api/v1/users' });
    registerBetterAuthRoutes(app, createBetterAuthHandler());
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await prisma.configAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { email: { endsWith: SUFFIX } } });
    await app?.close();
  });

  it('signs in a user created with a mixed-case email, however the address is typed', async () => {
    const res = await createUser({
      email: `  Mixed.Case${SUFFIX.toUpperCase()} `,
      password: PASSWORD,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.email).toBe(`mixed.case${SUFFIX}`);

    for (const typed of [`mixed.case${SUFFIX}`, `Mixed.Case${SUFFIX}`]) {
      const session = await signIn(typed);
      expect(session.statusCode, session.body).toBe(200);
      expect(session.json().user.email).toBe(`mixed.case${SUFFIX}`);
    }
  });

  it('refuses a second account that differs only in case', async () => {
    const first = await createUser({ email: `dupe${SUFFIX}`, password: PASSWORD });
    expect(first.statusCode, first.body).toBe(201);
    const second = await createUser({ email: `DUPE${SUFFIX}`, password: PASSWORD });
    expect(second.statusCode).toBe(409);
  });

  it('signs in a user created with the generated temporary password', async () => {
    const res = await createUser({ email: `Temp${SUFFIX}` });
    expect(res.statusCode, res.body).toBe(201);
    const session = await signIn(`temp${SUFFIX}`, res.json().data.temporaryPassword);
    expect(session.statusCode, session.body).toBe(200);
  });
});
