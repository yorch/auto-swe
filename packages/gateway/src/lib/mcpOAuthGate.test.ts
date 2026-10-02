import http from 'node:http';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The gate takes its collaborators as options, so none of better-auth, Prisma or the
// settings registry is exercised here; this file is about the policy alone. The
// end-to-end behaviour against the real plugin and Postgres is `mcpOAuthServer.pg.test.ts`.
vi.mock('./betterAuth.js', () => ({
  getAuth: vi.fn(),
  MCP_RESOURCE: 'http://test.local/api/v1/mcp',
}));

import { ipRateLimitKey } from '../plugins/auth.js';
import { registerBetterAuthRoutes } from './betterAuthHandler.js';
import { registerFormBodyParser } from './formBody.js';
import { mcpIssuanceRefusal } from './mcpOAuth.js';
import {
  type McpGateSettings,
  type McpOAuthGateOptions,
  mcpOAuthGate,
  narrowMetadata,
} from './mcpOAuthGate.js';

const RESOURCE = 'http://test.local/api/v1/mcp';
const REDIRECT = 'http://127.0.0.1:33333/cb';

interface Harness {
  app: FastifyInstance;
  /** Every request the better-auth stand-in actually received. */
  reached: Array<{ method: string; url: string; body: unknown; contentType?: string }>;
  settings: McpGateSettings;
  session: { isActive: boolean } | null;
  settingsError: boolean;
}

const apps: FastifyInstance[] = [];

async function makeApp(initial: Partial<McpGateSettings> = {}): Promise<Harness> {
  const h: Harness = {
    app: Fastify(),
    reached: [],
    session: null,
    settings: { enabled: true, writeToolsEnabled: false, ...initial },
    settingsError: false,
  };
  apps.push(h.app);
  registerFormBodyParser(h.app); // the real app's parser: it also keeps the raw string
  await h.app.register(rateLimit, {
    keyGenerator: ipRateLimitKey,
    max: 1000,
    timeWindow: '1 minute',
  });
  const options: McpOAuthGateOptions = {
    authServerMetadata: async () => new Response(JSON.stringify({ issuer: 'x' }), { status: 200 }),
    getSessionUser: async () => h.session,
    getSettings: async () => {
      if (h.settingsError) {
        throw new Error('db down');
      }
      return h.settings;
    },
    resource: RESOURCE,
  };
  await h.app.register(mcpOAuthGate, options);
  registerBetterAuthRoutes(h.app, async (request, reply) => {
    h.reached.push({
      body: request.body,
      contentType: request.headers['content-type'],
      method: request.method,
      url: request.url,
    });
    return reply.send({ reached: true });
  });
  await h.app.ready();
  return h;
}

/**
 * A request whose target is sent exactly as written. `inject()` resolves dot segments through
 * `new URL` before the app ever sees the path, so it cannot exercise a non-canonical one.
 */
async function rawRequest(app: FastifyInstance, method: string, target: string) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as { port: number };
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', method, path: target, port }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ body, status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const authorizeQuery = (extra: Record<string, string | null> = {}) => {
  const params = new URLSearchParams({
    client_id: 'c',
    code_challenge: 'x',
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT,
    resource: RESOURCE,
    response_type: 'code',
    scope: 'mcp:read',
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null)),
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) {
      params.delete(key);
    }
  }
  return params.toString();
};

describe('mcpOAuthGate: paths', () => {
  it('leaves non-OAuth better-auth paths alone, even with MCP off', async () => {
    const h = await makeApp({ enabled: false });
    for (const url of [
      '/api/auth/get-session',
      '/api/auth/sign-in/email',
      '/api/auth/callback/github',
    ]) {
      const method = url.endsWith('email') ? 'POST' : 'GET';
      const res = await h.app.inject({ method, payload: method === 'POST' ? {} : undefined, url });
      expect(res.statusCode, url).toBe(200);
    }
    expect(h.reached).toHaveLength(3);
  });

  it.each([
    ['POST', '/api/auth/oauth2/register'],
    ['GET', '/api/auth/oauth2/authorize'],
    ['POST', '/api/auth/oauth2/consent'],
    ['POST', '/api/auth/oauth2/continue'],
    ['POST', '/api/auth/oauth2/token'],
    ['POST', '/api/auth/oauth2/revoke'],
    ['GET', '/api/auth/oauth2/public-client'],
    ['GET', '/api/auth/jwks'],
    ['GET', '/.well-known/oauth-authorization-server/api/auth'],
  ])('mcp.enabled off: %s %s is 404 and never reaches better-auth', async (method, url) => {
    const h = await makeApp({ enabled: false });
    const res = await h.app.inject({
      method: method as 'GET',
      payload: method === 'POST' ? {} : undefined,
      url,
    });
    expect(res.statusCode).toBe(404);
    expect(h.reached).toHaveLength(0);
  });

  it('mcp.enabled on: the allowlisted endpoints and the discovery document are served', async () => {
    const h = await makeApp();
    const meta = await h.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/api/auth',
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({ issuer: 'x' });
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/jwks' })).statusCode).toBe(200);
    expect(
      (await h.app.inject({ method: 'POST', payload: {}, url: '/api/auth/oauth2/revoke' }))
        .statusCode
    ).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/auth/oauth2/public-client?client_id=c' }))
        .statusCode
    ).toBe(200);
  });

  // Every endpoint the plugin has that the allowlist does not name, plus the jwt plugin's
  // session-to-JWT endpoint, for both verbs.
  it.each([
    '/api/auth/oauth2/introspect',
    '/api/auth/oauth2/userinfo',
    '/api/auth/oauth2/end-session',
    '/api/auth/oauth2/create-client',
    '/api/auth/oauth2/update-client',
    '/api/auth/oauth2/delete-client',
    '/api/auth/oauth2/get-client',
    '/api/auth/oauth2/get-clients',
    '/api/auth/oauth2/client/rotate-secret',
    '/api/auth/oauth2/get-consent',
    '/api/auth/oauth2/get-consents',
    '/api/auth/oauth2/update-consent',
    '/api/auth/oauth2/delete-consent',
    '/api/auth/oauth2/public-client-prelogin',
    '/api/auth/admin/oauth2/create-client',
    '/api/auth/admin/oauth2/update-client',
    '/api/auth/admin/oauth2/resources',
    '/api/auth/admin/oauth2/resources/x/clients/y',
    '/api/auth/.well-known/openid-configuration',
    '/api/auth/.well-known/oauth-authorization-server',
    '/api/auth/token',
  ])('%s is 404', async (url) => {
    const h = await makeApp();
    for (const method of ['GET', 'POST'] as const) {
      const res = await h.app.inject({ method, payload: method === 'POST' ? {} : undefined, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(h.reached).toHaveLength(0);
  });

  // The same rules through every spelling that better-auth might resolve to a path they cover.
  it.each([
    ['dot segments', '/api/auth/oauth2/../oauth2/introspect'],
    ['encoded dot segments', '/api/auth/oauth2/%2e%2e/oauth2/introspect'],
    ['dot segments to the token endpoint', '/api/auth/oauth2/./../token'],
    ['backslash', '/api/auth/oauth2\\introspect'],
    ['dot segments to a blocked jwt route', '/api/auth/sign-in/../token'],
  ])('non-canonical path (%s) is 400 and never reaches better-auth', async (_name, url) => {
    const h = await makeApp();
    const res = await rawRequest(h.app, 'GET', url);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('NON_CANONICAL_PATH');
    expect(h.reached).toHaveLength(0);
  });

  it.each([
    ['upper case', '/api/auth/OAuth2/introspect'],
    ['encoded letter', '/api/auth/oauth2/intro%73pect'],
    ['encoded namespace', '/api/auth/%6fauth2/introspect'],
    ['trailing slash', '/api/auth/oauth2/introspect/'],
    ['doubled slash', '/api/auth//oauth2/introspect'],
    ['admin namespace, mixed case', '/api/auth/Admin/OAuth2/create-client'],
    ['token, upper case', '/api/auth/Token'],
    ['token, encoded', '/api/auth/%74oken'],
    ['token, trailing slash', '/api/auth/token/'],
    ['allowlisted endpoint, trailing slash', '/api/auth/oauth2/token/'],
    ['allowlisted endpoint, upper case', '/api/auth/OAUTH2/register'],
    ['allowlisted endpoint, encoded', '/api/auth/oauth2/regist%65r'],
    ['jwks, trailing slash', '/api/auth/jwks/'],
  ])('unusual spelling (%s) is 404 and never reaches better-auth', async (_name, url) => {
    const h = await makeApp();
    for (const method of ['GET', 'POST'] as const) {
      const res = await h.app.inject({ method, payload: method === 'POST' ? {} : undefined, url });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(h.reached).toHaveLength(0);
  });

  it('answers 503 rather than guessing a policy when the settings cannot be read', async () => {
    const h = await makeApp();
    h.settingsError = true;
    const res = await h.app.inject({ method: 'GET', url: '/api/auth/oauth2/authorize' });
    expect(res.statusCode).toBe(503);
    expect(h.reached).toHaveLength(0);
    const meta = await h.app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/api/auth',
    });
    expect(meta.statusCode).toBe(503);
    // Non-OAuth routes do not depend on the settings.
    expect((await h.app.inject({ method: 'GET', url: '/api/auth/get-session' })).statusCode).toBe(
      200
    );
  });
});

describe('mcpOAuthGate: authorize', () => {
  it('requires a resource', async () => {
    const h = await makeApp();
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/auth/oauth2/authorize?${authorizeQuery({ resource: null })}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
    expect(h.reached).toHaveLength(0);
  });

  it('refuses any other resource, including one among several', async () => {
    const h = await makeApp();
    for (const query of [
      authorizeQuery({ resource: 'https://other.example/api' }),
      `${authorizeQuery()}&resource=https://other.example/api`,
      `${authorizeQuery({ resource: null })}&resource=${RESOURCE}x`,
    ]) {
      const res = await h.app.inject({ method: 'GET', url: `/api/auth/oauth2/authorize?${query}` });
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toBe('invalid_target');
    }
    expect(h.reached).toHaveLength(0);
  });

  it('passes the MCP resource, by query or by urlencoded POST', async () => {
    const h = await makeApp();
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/auth/oauth2/authorize?${authorizeQuery()}` }))
        .statusCode
    ).toBe(200);
    const post = await h.app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: authorizeQuery(),
      url: '/api/auth/oauth2/authorize',
    });
    expect(post.statusCode).toBe(200);
    const bad = await h.app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: authorizeQuery({ resource: 'https://other.example' }),
      url: '/api/auth/oauth2/authorize',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses mcp:write while writes are off, and allows it once they are on', async () => {
    const h = await makeApp();
    const url = `/api/auth/oauth2/authorize?${authorizeQuery({ scope: 'mcp:read mcp:write offline_access' })}`;
    const refused = await h.app.inject({ method: 'GET', url });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('invalid_scope');
    h.settings.writeToolsEnabled = true;
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('asks for a scope while writes are off, since an absent one means the client registered scopes', async () => {
    const h = await makeApp();
    const url = `/api/auth/oauth2/authorize?${authorizeQuery({ scope: null })}`;
    const refused = await h.app.inject({ method: 'GET', url });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('invalid_scope');
    h.settings.writeToolsEnabled = true;
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('refuses an inactive account, and lets an anonymous or active one through', async () => {
    const h = await makeApp();
    const url = `/api/auth/oauth2/authorize?${authorizeQuery()}`;
    h.session = { isActive: false };
    const refused = await h.app.inject({ method: 'GET', url });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('access_denied');
    h.session = null;
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    h.session = { isActive: true };
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(200);
    expect(h.reached).toHaveLength(2);
  });
});

describe('mcpOAuthGate: consent and continue', () => {
  const post = (h: Harness, path: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', payload, url: `/api/auth/oauth2/${path}` });

  it.each(['consent', 'continue'])('%s: refuses an inactive account', async (path) => {
    const h = await makeApp();
    h.session = { isActive: false };
    const res = await post(h, path, { accept: true, oauth_query: authorizeQuery() });
    expect(res.statusCode).toBe(403);
    expect(h.reached).toHaveLength(0);
  });

  it.each(['consent', 'continue'])(
    '%s: the signed original request must name the MCP resource',
    async (path) => {
      const h = await makeApp();
      const missing = await post(h, path, {
        accept: true,
        oauth_query: authorizeQuery({ resource: null }),
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toBe('invalid_target');
      const other = await post(h, path, {
        accept: true,
        oauth_query: authorizeQuery({ resource: 'https://other.example' }),
      });
      expect(other.statusCode).toBe(400);
      expect(
        (await post(h, path, { accept: true, oauth_query: authorizeQuery() })).statusCode
      ).toBe(200);
    }
  );

  it.each(['consent', 'continue'])(
    '%s: a write request that finishes after writes were turned off is refused',
    async (path) => {
      const h = await makeApp({ writeToolsEnabled: true });
      const oauth_query = authorizeQuery({ scope: 'mcp:read mcp:write' });
      expect((await post(h, path, { accept: true, oauth_query })).statusCode).toBe(200);
      h.settings.writeToolsEnabled = false;
      const res = await post(h, path, { accept: true, oauth_query });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_scope');
    }
  );

  it('consent: the narrowed scope is checked too, and a read-only narrowing passes while writes are off', async () => {
    const h = await makeApp();
    const oauth_query = authorizeQuery();
    expect(
      (await post(h, 'consent', { accept: true, oauth_query, scope: 'mcp:read' })).statusCode
    ).toBe(200);
    const res = await post(h, 'consent', {
      accept: true,
      oauth_query,
      scope: 'mcp:read mcp:write',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
  });

  it('consent: a denial passes through', async () => {
    const h = await makeApp();
    expect(
      (await post(h, 'consent', { accept: false, oauth_query: authorizeQuery() })).statusCode
    ).toBe(200);
  });
});

describe('mcpOAuthGate: token', () => {
  const form = (h: Harness, fields: Record<string, string>) =>
    h.app.inject({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      payload: new URLSearchParams(fields).toString(),
      url: '/api/auth/oauth2/token',
    });

  it('refuses a token request for another resource and passes the MCP one or none', async () => {
    const h = await makeApp();
    const bad = await form(h, {
      grant_type: 'authorization_code',
      resource: 'https://other.example',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_target');
    expect(
      (await form(h, { grant_type: 'authorization_code', resource: RESOURCE })).statusCode
    ).toBe(200);
    expect((await form(h, { grant_type: 'refresh_token' })).statusCode).toBe(200);
    expect(h.reached).toHaveLength(2);
  });
});

describe('mcpOAuthGate: registration', () => {
  const register = (h: Harness, payload: Record<string, unknown>, remoteAddress = '203.0.113.7') =>
    h.app.inject({ method: 'POST', payload, remoteAddress, url: '/api/auth/oauth2/register' });
  const forwarded = (h: Harness) => h.reached.at(-1)?.body as Record<string, unknown>;

  it('forces a public client', async () => {
    const h = await makeApp();
    expect((await register(h, { redirect_uris: [REDIRECT] })).statusCode).toBe(200);
    expect(forwarded(h).token_endpoint_auth_method).toBe('none');
    for (const method of ['client_secret_basic', 'client_secret_post', 'private_key_jwt']) {
      const res = await register(h, {
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: method,
      });
      expect(res.statusCode, method).toBe(400);
      expect(res.json().error).toBe('invalid_client_metadata');
    }
    expect(
      (await register(h, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }))
        .statusCode
    ).toBe(200);
    expect(h.reached).toHaveLength(2);
  });

  it('refuses a back-channel logout target, which the server would call on sign-out', async () => {
    const h = await makeApp();
    for (const extra of [
      { backchannel_logout_uri: 'https://example.com/logout' },
      { backchannel_logout_session_required: true },
    ]) {
      expect((await register(h, { redirect_uris: [REDIRECT], ...extra })).statusCode).toBe(400);
    }
    expect(h.reached).toHaveLength(0);
  });

  it('defaults application_type to native for an SDK-1.x-style loopback or private-use client', async () => {
    const h = await makeApp();
    for (const redirect_uris of [
      ['http://127.0.0.1:33333/cb'],
      ['http://localhost:8080/callback'],
      ['http://[::1]:9000/cb'],
      ['com.example.app:/oauth'],
      ['http://127.0.0.1:1/cb', 'com.example.app:/oauth'],
    ]) {
      await register(h, { redirect_uris });
      expect(forwarded(h).application_type, JSON.stringify(redirect_uris)).toBe('native');
    }
  });

  it('leaves application_type alone when it is given or the redirects are not all native', async () => {
    const h = await makeApp();
    await register(h, { application_type: 'web', redirect_uris: [REDIRECT] });
    expect(forwarded(h).application_type).toBe('web');
    await register(h, { redirect_uris: ['https://app.example.com/cb'] });
    expect(forwarded(h).application_type).toBeUndefined();
    await register(h, { redirect_uris: [REDIRECT, 'https://app.example.com/cb'] });
    expect(forwarded(h).application_type).toBeUndefined();
    await register(h, { redirect_uris: ['http://example.com/cb'] });
    expect(forwarded(h).application_type).toBeUndefined();
    await register(h, {});
    expect(forwarded(h).application_type).toBeUndefined();
  });

  it('passes a malformed body to the plugin to reject', async () => {
    const h = await makeApp();
    const res = await h.app.inject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      payload: '[]',
      url: '/api/auth/oauth2/register',
    });
    expect(res.statusCode).toBe(200);
    expect(h.reached).toHaveLength(1);
  });

  it('is rate limited per client IP, tighter than the global limit', async () => {
    const h = await makeApp();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await register(h, { redirect_uris: [REDIRECT] })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // Another client is unaffected, and so is sign-in from the limited one.
    expect((await register(h, { redirect_uris: [REDIRECT] }, '203.0.113.8')).statusCode).toBe(200);
    expect(
      (
        await h.app.inject({
          method: 'GET',
          remoteAddress: '203.0.113.7',
          url: '/api/auth/get-session',
        })
      ).statusCode
    ).toBe(200);
  });
});

const form = (h: Harness, method: 'POST', url: string, body: string) =>
  h.app.inject({
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method,
    payload: body,
    url,
  });

describe('mcpOAuthGate: POST /oauth2/authorize reads the body, so the gate does too', () => {
  const AUTHORIZE = '/api/auth/oauth2/authorize';

  it('refuses a POST whose body asks for write while its query says read', async () => {
    const h = await makeApp();
    const res = await form(
      h,
      'POST',
      `${AUTHORIZE}?scope=mcp:read&resource=${encodeURIComponent(RESOURCE)}`,
      authorizeQuery({ scope: 'mcp:read mcp:write' })
    );
    expect(res.statusCode).toBe(400);
    expect(h.reached).toHaveLength(0);
  });

  it('refuses a body write scope while writes are off, even with a clean query', async () => {
    const h = await makeApp();
    const res = await form(h, 'POST', AUTHORIZE, authorizeQuery({ scope: 'mcp:read mcp:write' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
  });

  it('refuses a POST with no scope in the body, which the plugin would fill from the client', async () => {
    const h = await makeApp();
    const res = await form(
      h,
      'POST',
      `${AUTHORIZE}?scope=mcp:read`,
      authorizeQuery({ scope: null })
    );
    expect(res.statusCode).toBe(400);
    expect(h.reached).toHaveLength(0);
  });

  it('refuses a POST whose resource is only in the query, which the plugin would not see', async () => {
    const h = await makeApp({ writeToolsEnabled: true });
    const res = await form(
      h,
      'POST',
      `${AUTHORIZE}?resource=${encodeURIComponent(RESOURCE)}`,
      authorizeQuery({ resource: null })
    );
    expect(res.statusCode).toBe(400);
    expect(h.reached).toHaveLength(0);
  });

  it('refuses scope or resource given more than once, in the query or the body', async () => {
    const h = await makeApp({ writeToolsEnabled: true });
    const get = (query: string) => h.app.inject({ method: 'GET', url: `${AUTHORIZE}?${query}` });
    expect((await get(`${authorizeQuery()}&scope=mcp:read`)).statusCode).toBe(400);
    expect((await get(`${authorizeQuery()}&resource=${RESOURCE}`)).statusCode).toBe(400);
    expect(
      (await form(h, 'POST', AUTHORIZE, `${authorizeQuery()}&scope=mcp:write`)).statusCode
    ).toBe(400);
    expect(
      (await form(h, 'POST', AUTHORIZE, `${authorizeQuery()}&resource=${RESOURCE}`)).statusCode
    ).toBe(400);
    expect(h.reached).toHaveLength(0);
  });

  it('passes a well-formed POST', async () => {
    const h = await makeApp();
    expect((await form(h, 'POST', AUTHORIZE, authorizeQuery())).statusCode).toBe(200);
  });

  it('refuses a repeated resource at the token endpoint', async () => {
    const h = await makeApp();
    const res = await form(
      h,
      'POST',
      '/api/auth/oauth2/token',
      `grant_type=refresh_token&resource=${RESOURCE}&resource=${RESOURCE}`
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_target');
  });
});

describe('mcpOAuthGate: an authorization resumed after sign-in', () => {
  const signIn = (h: Harness) =>
    h.app.inject({
      method: 'POST',
      payload: { email: 'a@b.c', oauth_query: authorizeQuery(), password: 'x' },
      url: '/api/auth/sign-in/email',
    });

  it('drops the pending authorization while MCP is off, so sign-in just signs in', async () => {
    const h = await makeApp({ enabled: false });
    expect((await signIn(h)).statusCode).toBe(200);
    expect(h.reached[0]?.body).toEqual({ email: 'a@b.c', password: 'x' });
  });

  it('leaves it alone while MCP is on', async () => {
    const h = await makeApp();
    await signIn(h);
    expect(h.reached[0]?.body).toMatchObject({ oauth_query: expect.any(String) });
  });
});

describe('mcpIssuanceRefusal', () => {
  const on = { enabled: true, writeToolsEnabled: false };
  it('allows an active account reading', () => {
    expect(mcpIssuanceRefusal({ isActive: true }, ['mcp:read', 'offline_access'], on)).toBeNull();
  });
  it('refuses when MCP is off, the account is inactive or missing, or write is held while off', () => {
    expect(
      mcpIssuanceRefusal({ isActive: true }, ['mcp:read'], { ...on, enabled: false })
    ).toBeTruthy();
    expect(mcpIssuanceRefusal({ isActive: false }, ['mcp:read'], on)).toBeTruthy();
    expect(mcpIssuanceRefusal({}, ['mcp:read'], on)).toBeTruthy();
    expect(mcpIssuanceRefusal(null, ['mcp:read'], on)).toBeTruthy();
    expect(mcpIssuanceRefusal({ isActive: true }, ['mcp:read', 'mcp:write'], on)).toBeTruthy();
    expect(
      mcpIssuanceRefusal({ isActive: true }, ['mcp:write'], { ...on, writeToolsEnabled: true })
    ).toBeNull();
  });
});

describe('discovery metadata', () => {
  const provider = {
    backchannel_logout_session_supported: true,
    backchannel_logout_supported: true,
    code_challenge_methods_supported: ['S256'],
    introspection_endpoint: 'x',
    introspection_endpoint_auth_methods_supported: ['client_secret_basic'],
    issuer: 'i',
    revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
    revocation_endpoint_auth_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['RS256'],
  };

  it('narrowMetadata drops what the gate refuses and keeps the rest', () => {
    expect(narrowMetadata(provider)).toEqual({
      code_challenge_methods_supported: ['S256'],
      issuer: 'i',
      revocation_endpoint_auth_methods_supported: ['none'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  it('is what the discovery route serves', async () => {
    const h = await makeApp();
    // the harness stub returns only { issuer }; replace it with a provider-shaped document
    const app = Fastify();
    apps.push(app);
    await app.register(mcpOAuthGate, {
      authServerMetadata: async () => new Response(JSON.stringify(provider), { status: 200 }),
      getSessionUser: async () => null,
      getSettings: async () => ({ enabled: true, writeToolsEnabled: false }),
      resource: RESOURCE,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/api/auth',
    });
    expect(res.json().introspection_endpoint).toBeUndefined();
    expect(res.json().token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(h.reached).toHaveLength(0);
  });
});
