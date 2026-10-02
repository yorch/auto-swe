import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  requests: [] as Array<{
    body: string | null;
    contentType: string | null;
    method: string;
    url: string;
  }>,
  status: 200,
}));

vi.mock('./betterAuth.js', () => ({
  getAuth: () => ({
    handler: async (req: Request) => {
      seen.requests.push({
        body: req.body ? await req.text() : null,
        contentType: req.headers.get('content-type'),
        method: req.method,
        url: req.url,
      });
      return new Response('{}', { headers: { 'x-from': 'auth' }, status: seen.status });
    },
  }),
}));

import { _cacheSessionForTests, _hasCachedSessionForTests } from '../plugins/auth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './betterAuthHandler.js';
import { registerFormBodyParser } from './formBody.js';

const apps: FastifyInstance[] = [];
async function makeApp() {
  const app = Fastify();
  apps.push(app);
  registerFormBodyParser(app);
  registerBetterAuthRoutes(app, createBetterAuthHandler());
  await app.ready();
  seen.requests.length = 0;
  seen.status = 200;
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

// What better-auth receives is the contract between this gateway and the plugin: the OAuth
// token endpoint refuses anything but a form, and every other endpoint wants JSON.
describe('createBetterAuthHandler request body', () => {
  it('sends a JSON body as JSON', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', payload: { a: 1 }, url: '/api/auth/sign-in/email' });
    expect(seen.requests[0]?.contentType).toBe('application/json');
    expect(seen.requests[0]?.body).toBe('{"a":1}');
  });

  it('keeps a urlencoded body urlencoded under /api/auth/oauth2/, repeated keys intact', async () => {
    const app = await makeApp();
    await app.inject({
      headers: FORM,
      method: 'POST',
      payload: 'grant_type=refresh_token&resource=a&resource=b',
      url: '/api/auth/oauth2/token',
    });
    expect(seen.requests[0]?.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(seen.requests[0]?.body).toBe('grant_type=refresh_token&resource=a&resource=b');
  });

  it('re-serializes a urlencoded body as JSON everywhere else (the social sign-in forms)', async () => {
    const app = await makeApp();
    await app.inject({
      headers: FORM,
      method: 'POST',
      payload: 'provider=github&callbackURL=%2Fx',
      url: '/api/auth/sign-in/social',
    });
    expect(seen.requests[0]?.contentType).toBe('application/json');
    expect(JSON.parse(seen.requests[0]?.body as string)).toEqual({
      callbackURL: '/x',
      provider: 'github',
    });
  });

  it('passes a text/plain body through untouched', async () => {
    const app = await makeApp();
    await app.inject({
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'hello',
      url: '/api/auth/sign-in/email',
    });
    expect(seen.requests[0]?.body).toBe('hello');
    expect(seen.requests[0]?.contentType).toMatch(/^text\/plain/);
  });

  it('sends no body when there is none', async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    expect(seen.requests[0]?.body).toBeNull();
  });

  it('copies the response status and headers back', async () => {
    const app = await makeApp();
    seen.status = 201;
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-from']).toBe('auth');
  });

  it('refuses a non-canonical path without calling better-auth', async () => {
    const app = await makeApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    // Sent as written: `fetch` and `inject` both resolve dot segments before the app sees them.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', path: '/api/auth/%2e%2e/api/auth/get-session', port },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(seen.requests).toHaveLength(0);
  });
});

describe('createBetterAuthHandler session cache', () => {
  it('drops the cached session when sign-out succeeds, and only then', async () => {
    const app = await makeApp();
    const cookie = 'better-auth.session_token=tok.sig';
    const payload = { exp: 9_999_999_999, iat: 0, role: 'ENGINEER' as const, sub: 'u' };
    _cacheSessionForTests('tok.sig', payload);
    seen.status = 500;
    await app.inject({
      headers: { cookie },
      method: 'POST',
      payload: {},
      url: '/api/auth/sign-out',
    });
    expect(_hasCachedSessionForTests('tok.sig')).toBe(true);
    seen.status = 200;
    await app.inject({
      headers: { cookie },
      method: 'POST',
      payload: {},
      url: '/api/auth/sign-out',
    });
    expect(_hasCachedSessionForTests('tok.sig')).toBe(false);
  });
});
