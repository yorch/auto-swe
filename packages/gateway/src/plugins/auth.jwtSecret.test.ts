import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authPlugin, { _resetAuthCachesForTests } from './auth.js';

/**
 * `.env.example` ships a blank `JWT_SECRET=` line, and both dotenv and Compose
 * pass it through as the empty string. A blank secret must be treated as
 * unset: refused outside development/test, the dev fallback inside it — never
 * handed to HS256 as an empty key.
 */

const USER_ID = '00000000-0000-4000-8000-0000000000aa';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  const findUnique = vi.fn().mockResolvedValue({ isActive: true, role: 'ADMIN', slackId: null });
  app.decorate('prisma', { user: { findUnique } } as never);
  await app.register(authPlugin);
  await app.ready();
  return app;
}

describe('auth plugin — blank JWT_SECRET', () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    _resetAuthCachesForTests();
    vi.stubEnv('JWT_PRIVATE_KEY_PATH', '');
    vi.stubEnv('JWT_PUBLIC_KEY_PATH', '');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    app = undefined;
  });

  it.each(['', '   '])(
    'refuses to boot outside development/test when JWT_SECRET is %j',
    async (value) => {
      vi.stubEnv('JWT_SECRET', value);
      vi.stubEnv('NODE_ENV', 'production');

      await expect(buildApp()).rejects.toThrow(/JWT_SECRET .* must be set/);
    }
  );

  it('falls back to the dev secret in development when JWT_SECRET is blank', async () => {
    vi.stubEnv('JWT_SECRET', '');
    vi.stubEnv('NODE_ENV', 'development');
    app = await buildApp();

    const token = app.auth.signAccessToken({ role: 'ADMIN', sub: USER_ID });
    const payload = await app.auth.verifyAccessToken(token);

    expect(payload.sub).toBe(USER_ID);
  });
});
