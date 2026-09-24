import type { FastifyRequest } from 'fastify';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authPlugin, {
  _cacheSessionForTests,
  _hasCachedSessionForTests,
  _resetAuthCachesForTests,
  invalidateSessionCache,
  invalidateUserAuthCache,
  ipRateLimitKey,
  type JwtPayload,
  rateLimitKey,
} from './auth.js';

/**
 * The real auth plugin's token verification, against a mocked users table.
 * `auth.hook.test.ts` stubs `verifyAccessToken` out; this file is where what
 * that stub stands in for is itself checked.
 */

const USER_ID = '00000000-0000-4000-8000-0000000000aa';

async function buildApp(findUnique: ReturnType<typeof vi.fn>): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('prisma', { user: { findUnique } } as never);
  await app.register(authPlugin);
  await app.ready();
  return app;
}

describe('auth plugin — verifyAccessToken re-reads the user', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    _resetAuthCachesForTests();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('authorizes on the current DB role, not the role claim minted into the token', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ isActive: true, role: 'ENGINEER', slackId: null });
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });

    const payload = await app.auth.verifyAccessToken(token);

    expect(payload.role).toBe('ENGINEER');
    expect(payload.sub).toBe(USER_ID);
  });

  it('rejects a token whose user has been deactivated', async () => {
    const findUnique = vi.fn().mockResolvedValue({ isActive: false, role: 'ADMIN', slackId: null });
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });

    await expect(app.auth.verifyAccessToken(token)).rejects.toThrow(/inactive/);
  });

  it('rejects a token whose user no longer exists', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });

    await expect(app.auth.verifyAccessToken(token)).rejects.toThrow();
  });

  it('serves repeat verifications from the cache until the user is invalidated', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ isActive: true, role: 'ADMIN', slackId: null })
      .mockResolvedValueOnce({ isActive: false, role: 'ADMIN', slackId: null });
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });

    await app.auth.verifyAccessToken(token);
    await app.auth.verifyAccessToken(token);
    expect(findUnique).toHaveBeenCalledTimes(1);

    invalidateUserAuthCache(USER_ID);
    await expect(app.auth.verifyAccessToken(token)).rejects.toThrow(/inactive/);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('reports a failed user lookup as an outage, not as a bad token', async () => {
    const findUnique = vi.fn().mockRejectedValue(new Error('connection refused to db-host:5432'));
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });

    await expect(app.auth.verifyAccessToken(token)).rejects.toMatchObject({
      name: 'TokenUserLookupError',
    });
  });

  it('still rejects a token with a bad signature before touching the database', async () => {
    const findUnique = vi.fn();
    app = await buildApp(findUnique);

    await expect(app.auth.verifyAccessToken('not-a-jwt')).rejects.toThrow();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('session cache invalidation', () => {
  const payload: JwtPayload = { exp: 0, iat: 0, role: 'ENGINEER', sub: USER_ID };

  beforeEach(() => {
    _resetAuthCachesForTests();
  });

  it('drops an entry by the bare DB token even though the cache is keyed by the signed cookie', () => {
    _cacheSessionForTests('abc123.c2lnbmF0dXJl', payload);

    invalidateSessionCache('abc123');

    expect(_hasCachedSessionForTests('abc123.c2lnbmF0dXJl')).toBe(false);
  });

  it('drops an entry by the signed cookie value (the sign-out path)', () => {
    _cacheSessionForTests('abc123.c2lnbmF0dXJl', payload);

    invalidateSessionCache('abc123.c2lnbmF0dXJl');

    expect(_hasCachedSessionForTests('abc123.c2lnbmF0dXJl')).toBe(false);
  });

  it('does not drop a different session that merely shares a prefix', () => {
    _cacheSessionForTests('abc1234.c2ln', payload);

    invalidateSessionCache('abc123');

    expect(_hasCachedSessionForTests('abc1234.c2ln')).toBe(true);
  });

  it('invalidateUserAuthCache drops every cached session for that user only', () => {
    _cacheSessionForTests('a.sig', payload);
    _cacheSessionForTests('b.sig', payload);
    _cacheSessionForTests('c.sig', { ...payload, sub: 'someone-else' });

    invalidateUserAuthCache(USER_ID);

    expect(_hasCachedSessionForTests('a.sig')).toBe(false);
    expect(_hasCachedSessionForTests('b.sig')).toBe(false);
    expect(_hasCachedSessionForTests('c.sig')).toBe(true);
  });
});

describe('rateLimitKey', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    _resetAuthCachesForTests();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function req(server: FastifyInstance, headers: Record<string, string>): FastifyRequest {
    return { headers, ip: '10.0.0.9', server } as unknown as FastifyRequest;
  }

  it('buckets a verified JWT by its user, without a database read', async () => {
    const findUnique = vi.fn();
    app = await buildApp(findUnique);
    const token = app.auth.signAccessToken({ role: 'ENGINEER', sub: USER_ID });

    expect(rateLimitKey(req(app, { authorization: `Bearer ${token}` }))).toBe(`user:${USER_ID}`);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('falls back to the IP for an invalid bearer, so random tokens cannot mint buckets', async () => {
    app = await buildApp(vi.fn());
    expect(rateLimitKey(req(app, { authorization: 'Bearer forged' }))).toBe('ip:10.0.0.9');
    expect(rateLimitKey(req(app, { authorization: 'Bearer ats_whatever' }))).toBe('ip:10.0.0.9');
  });

  it('buckets an IPv6 client by its /64, as the default key generator does', async () => {
    app = await buildApp(vi.fn());
    const v6 = (ip: string) => ({ headers: {}, ip, server: app }) as unknown as FastifyRequest;
    // Rotating the interface identifier inside one /64 must not mint a new bucket.
    expect(rateLimitKey(v6('2001:db8:1:2::1'))).toBe(rateLimitKey(v6('2001:db8:1:2:ffff::9')));
    expect(ipRateLimitKey(v6('2001:db8:1:2::1'))).not.toBe(ipRateLimitKey(v6('2001:db8:1:3::1')));
  });

  it('buckets a session cookie by user only once the session is verified (cached)', async () => {
    app = await buildApp(vi.fn());
    const cookie = { cookie: 'better-auth.session_token=tok.sig' };
    expect(rateLimitKey(req(app, cookie))).toBe('ip:10.0.0.9');

    _cacheSessionForTests('tok.sig', { exp: 0, iat: 0, role: 'ENGINEER', sub: USER_ID });
    expect(rateLimitKey(req(app, cookie))).toBe(`user:${USER_ID}`);
  });
});
