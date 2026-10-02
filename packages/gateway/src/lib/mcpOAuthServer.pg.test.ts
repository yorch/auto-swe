import crypto from 'node:crypto';
import http from 'node:http';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import rateLimit from '@fastify/rate-limit';
import { hashPassword } from 'better-auth/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ipRateLimitKey } from '../plugins/auth.js';
import { getAuth, initAuth, MCP_RESOURCE } from './betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './betterAuthHandler.js';
import { MCP_JWKS_GRACE_SECONDS, mcpIssuerFor } from './mcpOAuth.js';
import { mcpOAuthGate } from './mcpOAuthGate.js';
import { mcpOAuthGateOptions } from './mcpOAuthGateOptions.js';

/**
 * The authorization server end to end: the real better-auth OAuth provider, through the
 * Prisma adapter, against Postgres with the committed migrations applied.
 *
 * This is deliberately not the memory adapter. The plugin treats a `NULL` array column and
 * an empty one differently, and the boot-time resource seed and the nullability of the
 * array columns only show up against the real schema.
 *
 * Opt in with `MCP_OAUTH_PG_TEST=1` and a `DATABASE_URL` pointing at a database that
 * `prisma migrate deploy` has been run against (it creates and deletes rows, so use a
 * throwaway one):
 *
 *   docker run -d --rm --name mcp-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55440:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55440/t yarn workspace @auto-swe/shared db:deploy
 *   MCP_OAUTH_PG_TEST=1 DATABASE_URL=... yarn vitest run packages/gateway/src/lib/mcpOAuthServer.pg.test.ts
 */
const enabled = process.env.MCP_OAUTH_PG_TEST === '1';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:8080';
const ISSUER = mcpIssuerFor('http://localhost:8080');
const REDIRECT = 'http://127.0.0.1:33333/cb';
const PASSWORD = 'correct horse battery staple';

const b64url = (buf: Buffer) => buf.toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), verifier };
};
const decodePart = (jwt: string, index: 0 | 1) =>
  JSON.parse(Buffer.from(jwt.split('.')[index] as string, 'base64url').toString('utf8'));

describe.skipIf(!enabled)('OAuth authorization server against Postgres', () => {
  let app: FastifyInstance;
  const settings = { enabled: true, writeToolsEnabled: false };
  let userSeq = 0;

  const call = (
    method: 'GET' | 'POST',
    url: string,
    opts: { cookie?: string; json?: unknown; form?: Record<string, string> } = {}
  ) =>
    app.inject({
      headers: {
        host: HOST,
        origin: ORIGIN,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      method,
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
      remoteAddress: `198.51.100.${(userSeq++ % 250) + 1}`,
      url,
    });

  async function makeUser(opts: { active?: boolean } = {}) {
    const email = `mcp-${Date.now()}-${userSeq++}@example.test`;
    const user = await prisma.user.create({
      data: { email, emailVerified: true, isActive: opts.active ?? true, name: 'MCP Test' },
    });
    await prisma.account.create({
      data: {
        accountId: user.id,
        password: await hashPassword(PASSWORD),
        providerId: 'credential',
        userId: user.id,
      },
    });
    const res = await call('POST', '/api/auth/sign-in/email', {
      json: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    return { cookie, email, id: user.id };
  }

  /** DCR the way an SDK-2.0 client does it: a public client with both grants and every scope. */
  async function registerClient(extra: Record<string, unknown> = {}) {
    const res = await call('POST', '/api/auth/oauth2/register', {
      json: {
        client_name: 'Test MCP Client',
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT],
        response_types: ['code'],
        scope: 'mcp:read mcp:write offline_access',
        token_endpoint_auth_method: 'none',
        ...extra,
      },
    });
    return { body: res.json(), res };
  }

  const authorizeUrl = (clientId: string, o: Record<string, string | null> = {}) => {
    const params = new URLSearchParams({
      client_id: clientId,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT,
      resource: MCP_RESOURCE,
      response_type: 'code',
      scope: 'mcp:read',
      state: 'st-1',
    });
    for (const [k, v] of Object.entries(o)) {
      if (v === null) {
        params.delete(k);
      } else {
        params.set(k, v);
      }
    }
    return `/api/auth/oauth2/authorize?${params.toString()}`;
  };

  /** Authorize + consent for a signed-in user; returns the code the client would receive. */
  async function grant(
    cookie: string,
    clientId: string,
    o: { scope?: string; verifier?: string; accept?: boolean; narrow?: string } = {}
  ) {
    const { challenge, verifier } = o.verifier
      ? {
          challenge: b64url(crypto.createHash('sha256').update(o.verifier).digest()),
          verifier: o.verifier,
        }
      : pkce();
    const auth = await call(
      'GET',
      authorizeUrl(clientId, { code_challenge: challenge, ...(o.scope ? { scope: o.scope } : {}) }),
      { cookie }
    );
    expect(auth.statusCode, auth.body).toBe(302);
    const consentUrl = new URL(String(auth.headers.location));
    expect(`${consentUrl.origin}${consentUrl.pathname}`).toBe(`${ORIGIN}/oauth/consent`);
    const consent = await call('POST', '/api/auth/oauth2/consent', {
      cookie,
      json: {
        accept: o.accept ?? true,
        oauth_query: consentUrl.search.slice(1),
        ...(o.narrow ? { scope: o.narrow } : {}),
      },
    });
    expect(consent.statusCode, consent.body).toBe(200);
    const redirect = new URL(consent.json().url ?? consent.json().redirect_uri);
    return { redirect, verifier };
  }

  const exchange = (
    clientId: string,
    code: string,
    verifier: string,
    extra: Record<string, string> = {}
  ) =>
    call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
        ...extra,
      },
    });

  async function fullFlow(scope = 'mcp:read offline_access') {
    const user = await makeUser();
    const { body: client } = await registerClient();
    const { redirect, verifier } = await grant(user.cookie, client.client_id, { scope });
    const code = redirect.searchParams.get('code') as string;
    expect(code).toBeTruthy();
    const tokens = await exchange(client.client_id, code, verifier);
    expect(tokens.statusCode, tokens.body).toBe(200);
    return { client, redirect, tokens: tokens.json(), user };
  }

  async function reset() {
    invalidateSettingsCache();
    settings.enabled = true;
    settings.writeToolsEnabled = false;
    await prisma.oauthAccessToken.deleteMany();
    await prisma.oauthRefreshToken.deleteMany();
    await prisma.oauthConsent.deleteMany();
    await prisma.oauthClient.deleteMany();
  }

  beforeAll(async () => {
    await initAuth();
    app = Fastify();
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_r, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      }
    );
    await app.register(rateLimit, {
      keyGenerator: ipRateLimitKey,
      max: 10_000,
      timeWindow: '1 minute',
    });
    await app.register(mcpOAuthGate, {
      ...mcpOAuthGateOptions(),
      getSettings: async () => ({ ...settings }),
    });
    registerBetterAuthRoutes(app, createBetterAuthHandler());
    await app.ready();
  }, 60_000);

  beforeEach(reset);

  afterAll(async () => {
    await reset();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@example.test' } } });
    await app?.close();
  });

  describe('discovery', () => {
    it('advertises S256, iss support and offline_access, and no client_credentials', async () => {
      const res = await call('GET', '/.well-known/oauth-authorization-server/api/auth');
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.issuer).toBe(ISSUER);
      expect(doc.code_challenge_methods_supported).toEqual(['S256']);
      expect(doc.authorization_response_iss_parameter_supported).toBe(true);
      expect(doc.scopes_supported).toEqual(
        expect.arrayContaining(['mcp:read', 'mcp:write', 'offline_access'])
      );
      expect(doc.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(doc.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
      expect(doc.response_types_supported).toEqual(['code']);
    });

    it('publishes the signing keys', async () => {
      const res = await call('GET', '/api/auth/jwks');
      expect(res.statusCode).toBe(200);
      expect(res.json().keys[0]).toMatchObject({ alg: 'EdDSA', kty: 'OKP' });
    });
  });

  describe('authorization code flow', () => {
    it('lets an anonymous DCR client complete authorize, consent and token, and issues a JWT for the MCP resource', async () => {
      const { client, redirect, tokens, user } = await fullFlow();
      expect(client.client_secret).toBeUndefined();
      expect(client.resources).toEqual([MCP_RESOURCE]);
      expect(redirect.searchParams.get('iss')).toBe(ISSUER);
      expect(redirect.searchParams.get('state')).toBe('st-1');

      const jwt = tokens.access_token as string;
      const header = decodePart(jwt, 0);
      const payload = decodePart(jwt, 1);
      expect(header.typ).toBe('at+jwt');
      expect(header.alg).toBe('EdDSA');
      expect(payload.aud).toEqual(MCP_RESOURCE);
      expect(payload.iss).toBe(ISSUER);
      expect(payload.sub).toBe(user.id);
      expect(payload.client_id ?? payload.azp).toBe(client.client_id);
      expect(payload.scope).toBe('mcp:read offline_access');
      expect(payload.exp - payload.iat).toBe(600);
      expect(tokens.token_type).toBe('Bearer');

      // It verifies against the published keys.
      const { keys } = (await call('GET', '/api/auth/jwks')).json();
      const jwk = keys.find((k: { kid: string }) => k.kid === header.kid);
      expect(jwk).toBeTruthy();
      const [h, p, sig] = jwt.split('.') as [string, string, string];
      expect(
        crypto.verify(
          null,
          Buffer.from(`${h}.${p}`),
          crypto.createPublicKey({ format: 'jwk', key: jwk }),
          Buffer.from(sig, 'base64url')
        )
      ).toBe(true);

      // The grant is recorded for the user and the client.
      const consent = await prisma.oauthConsent.findFirstOrThrow({
        where: { clientId: client.client_id, userId: user.id },
      });
      expect(consent.scopes).toEqual(['mcp:read', 'offline_access']);
    });

    it('sends an anonymous browser to the login page with the request carried along', async () => {
      const { body: client } = await registerClient();
      const res = await call('GET', authorizeUrl(client.client_id));
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers.location));
      expect(`${loc.origin}${loc.pathname}`).toBe(`${ORIGIN}/login`);
      expect(loc.searchParams.get('client_id')).toBe(client.client_id);
      expect(loc.searchParams.get('sig')).toBeTruthy();
    });

    it('is a single-use code', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const { redirect, verifier } = await grant(user.cookie, client.client_id);
      const code = redirect.searchParams.get('code') as string;
      expect((await exchange(client.client_id, code, verifier)).statusCode).toBe(200);
      expect((await exchange(client.client_id, code, verifier)).statusCode).toBe(400);
    });
  });

  describe('PKCE', () => {
    it('refuses an authorization request with no code challenge', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const res = await call(
        'GET',
        authorizeUrl(client.client_id, { code_challenge: null, code_challenge_method: null }),
        { cookie: user.cookie }
      );
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers.location));
      expect(loc.origin).toBe(new URL(REDIRECT).origin);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('code')).toBeNull();
    });

    it('refuses the plain method', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const res = await call(
        'GET',
        authorizeUrl(client.client_id, { code_challenge_method: 'plain' }),
        { cookie: user.cookie }
      );
      const loc = new URL(String(res.headers.location));
      expect(loc.searchParams.get('error')).toBe('invalid_request');
    });

    it('fails the exchange on a wrong code_verifier', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const { redirect } = await grant(user.cookie, client.client_id);
      const res = await exchange(
        client.client_id,
        redirect.searchParams.get('code') as string,
        b64url(crypto.randomBytes(32))
      );
      // The plugin answers a PKCE mismatch with 401 invalid_request (RFC 6749 would say
      // 400 invalid_grant); what matters here is that nothing is issued.
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.json().error).toBeTruthy();
      expect(res.json().access_token).toBeUndefined();
    });
  });

  describe('refresh tokens', () => {
    it('issues a rotating refresh token for offline_access and refuses a replayed one', async () => {
      const { client, tokens } = await fullFlow('mcp:read offline_access');
      expect(tokens.refresh_token).toBeTruthy();

      const refresh = (token: string) =>
        call('POST', '/api/auth/oauth2/token', {
          form: {
            client_id: client.client_id,
            grant_type: 'refresh_token',
            refresh_token: token,
            resource: MCP_RESOURCE,
          },
        });
      const first = await refresh(tokens.refresh_token);
      expect(first.statusCode, first.body).toBe(200);
      const rotated = first.json();
      expect(rotated.refresh_token).toBeTruthy();
      expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
      const access = decodePart(rotated.access_token, 1);
      expect(access.aud).toEqual(MCP_RESOURCE);
      expect(access.scope).toBe('mcp:read offline_access');

      const replay = await refresh(tokens.refresh_token);
      expect(replay.statusCode).toBe(400);
      expect(replay.json().error).toBe('invalid_grant');
      // A replay is treated as theft: the rotated successor is revoked with it.
      expect((await refresh(rotated.refresh_token)).statusCode).toBe(400);
    });

    it('lets the rotated token be used in turn, so a client that refreshes keeps working', async () => {
      const { client, tokens } = await fullFlow('mcp:read offline_access');
      let current = tokens.refresh_token as string;
      for (let i = 0; i < 3; i++) {
        const res = await call('POST', '/api/auth/oauth2/token', {
          form: {
            client_id: client.client_id,
            grant_type: 'refresh_token',
            refresh_token: current,
            resource: MCP_RESOURCE,
          },
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().refresh_token).not.toBe(current);
        current = res.json().refresh_token;
      }
    });

    it('issues no refresh token without offline_access', async () => {
      const { tokens } = await fullFlow('mcp:read');
      expect(tokens.refresh_token).toBeUndefined();
    });

    it('stores refresh tokens hashed, not as the value the client holds', async () => {
      const { tokens } = await fullFlow('mcp:read offline_access');
      const stored = await prisma.oauthRefreshToken.findMany();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.token).not.toBe(tokens.refresh_token);
      expect(stored[0]?.scopes).toEqual(['mcp:read', 'offline_access']);
    });
  });

  describe('dynamic client registration', () => {
    it('rejects a confidential client', async () => {
      const { res } = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
      expect(res.statusCode).toBe(400);
      expect(await prisma.oauthClient.count()).toBe(0);
    });

    it('registers a loopback client that sends no application_type (an SDK-1.x style body) as native', async () => {
      const { body, res } = await registerClient({
        application_type: undefined,
        grant_types: undefined,
        response_types: undefined,
        scope: undefined,
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(body.application_type).toBe('native');
      expect(body.token_endpoint_auth_method).toBe('none');
      expect(body.resources).toEqual([MCP_RESOURCE]);
    });

    it('rejects a scope wider than the server knows', async () => {
      const { res } = await registerClient({ scope: 'mcp:read admin' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_scope');
    });

    it('rejects a back-channel logout target', async () => {
      const { res } = await registerClient({ backchannel_logout_uri: 'https://example.com/out' });
      expect(res.statusCode).toBe(400);
    });

    it('refuses to register a resource other than the MCP one', async () => {
      const { res } = await registerClient({ resources: ['https://other.example/api'] });
      expect(res.statusCode).toBe(400);
    });

    it('is rate limited per IP', async () => {
      const limited = Fastify();
      limited.addContentTypeParser(
        'application/x-www-form-urlencoded',
        { parseAs: 'string' },
        (_r, _body, done) => done(null, {})
      );
      await limited.register(rateLimit, {
        keyGenerator: ipRateLimitKey,
        max: 10_000,
        timeWindow: '1 minute',
      });
      await limited.register(mcpOAuthGate, {
        ...mcpOAuthGateOptions(),
        getSettings: async () => ({ ...settings }),
      });
      registerBetterAuthRoutes(limited, createBetterAuthHandler());
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await limited.inject({
          headers: { host: HOST },
          method: 'POST',
          payload: { client_name: 'x', redirect_uris: [REDIRECT] },
          remoteAddress: '203.0.113.99',
          url: '/api/auth/oauth2/register',
        });
        codes.push(res.statusCode);
      }
      await limited.close();
      expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
      expect(codes.slice(10)).toEqual([429, 429]);
    });
  });

  describe('consent', () => {
    it('on denial returns access_denied with iss to the redirect_uri and issues nothing', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const { redirect } = await grant(user.cookie, client.client_id, { accept: false });
      expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT);
      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.get('iss')).toBe(ISSUER);
      expect(redirect.searchParams.get('state')).toBe('st-1');
      expect(redirect.searchParams.get('code')).toBeNull();
      expect(await prisma.oauthConsent.count()).toBe(0);
      expect(await prisma.oauthRefreshToken.count()).toBe(0);
    });

    it('lets the user narrow the grant to read only', async () => {
      settings.writeToolsEnabled = true;
      const user = await makeUser();
      const { body: client } = await registerClient();
      const { redirect, verifier } = await grant(user.cookie, client.client_id, {
        narrow: 'mcp:read',
        scope: 'mcp:read mcp:write',
      });
      const tokens = await exchange(
        client.client_id,
        redirect.searchParams.get('code') as string,
        verifier
      );
      expect(decodePart(tokens.json().access_token, 1).scope).toBe('mcp:read');
    });
  });

  describe('write scope', () => {
    it('is refused while writes are disabled, and granted once they are enabled', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const url = authorizeUrl(client.client_id, { scope: 'mcp:read mcp:write' });
      const refused = await call('GET', url, { cookie: user.cookie });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe('invalid_scope');

      settings.writeToolsEnabled = true;
      const { redirect, verifier } = await grant(user.cookie, client.client_id, {
        scope: 'mcp:read mcp:write',
      });
      const tokens = await exchange(
        client.client_id,
        redirect.searchParams.get('code') as string,
        verifier
      );
      expect(decodePart(tokens.json().access_token, 1).scope).toBe('mcp:read mcp:write');
    });
  });

  describe('resource indicator', () => {
    it('refuses authorize with no resource, or another one', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      for (const resource of [null, 'https://other.example/api']) {
        const res = await call('GET', authorizeUrl(client.client_id, { resource }), {
          cookie: user.cookie,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('invalid_target');
      }
    });

    it('refuses a token request for another resource', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      const { redirect, verifier } = await grant(user.cookie, client.client_id);
      const res = await exchange(
        client.client_id,
        redirect.searchParams.get('code') as string,
        verifier,
        { resource: 'https://other.example/api' }
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_target');
    });
  });

  describe('gate', () => {
    it('refuses an inactive account at authorize', async () => {
      const user = await makeUser({ active: false });
      const { body: client } = await registerClient();
      const res = await call('GET', authorizeUrl(client.client_id), { cookie: user.cookie });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('access_denied');
    });

    it('with mcp.enabled off 404s every allowlisted endpoint and the discovery document', async () => {
      const user = await makeUser();
      const { body: client } = await registerClient();
      settings.enabled = false;
      const probes: Array<['GET' | 'POST', string]> = [
        ['GET', '/.well-known/oauth-authorization-server/api/auth'],
        ['GET', '/api/auth/.well-known/oauth-authorization-server'],
        ['GET', '/api/auth/jwks'],
        ['GET', authorizeUrl(client.client_id)],
        ['POST', '/api/auth/oauth2/register'],
        ['POST', '/api/auth/oauth2/token'],
        ['POST', '/api/auth/oauth2/consent'],
        ['POST', '/api/auth/oauth2/continue'],
        ['POST', '/api/auth/oauth2/revoke'],
        ['GET', `/api/auth/oauth2/public-client?client_id=${client.client_id}`],
      ];
      for (const [method, url] of probes) {
        const res = await call(method, url, {
          cookie: user.cookie,
          ...(method === 'POST' ? { json: {} } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      // Sign-in is not part of MCP and keeps working.
      expect((await call('GET', '/api/auth/get-session', { cookie: user.cookie })).statusCode).toBe(
        200
      );
    });

    it('404s the plugin endpoints the allowlist does not name, with a session', async () => {
      const user = await makeUser();
      const { client, tokens } = await fullFlow();
      for (const [method, url] of [
        ['GET', '/api/auth/token'],
        ['GET', '/api/auth/oauth2/get-clients'],
        ['GET', '/api/auth/oauth2/get-consents'],
        ['POST', '/api/auth/oauth2/delete-consent'],
        ['POST', '/api/auth/oauth2/introspect'],
        ['GET', '/api/auth/oauth2/userinfo'],
        ['POST', '/api/auth/oauth2/create-client'],
        ['POST', '/api/auth/admin/oauth2/create-client'],
        ['GET', '/api/auth/.well-known/openid-configuration'],
      ] as const) {
        const res = await call(method, url, {
          cookie: user.cookie,
          ...(method === 'POST'
            ? { json: { client_id: client.client_id, token: tokens.access_token } }
            : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
    });

    it.each([
      '/api/auth/oauth2/../oauth2/introspect',
      '/api/auth/oauth2/%2e%2e/token',
      '/api/auth/oauth2/./register',
      '/api/auth/oauth2\\introspect',
    ])('refuses the non-canonical path %s before it can reach the plugin', async (target) => {
      await app.listen({ host: '127.0.0.1', port: 0 }).catch(() => undefined);
      const { port } = app.server.address() as { port: number };
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', method: 'POST', path: target, port },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(400);
    });

    it('reads the real settings: off on a fresh deployment, on when an admin saves it', async () => {
      // GLOBAL settings belong to no tenant, which is the point of the fixture.
      const globalSettings = <T>(fn: () => Promise<T>) =>
        runUnscoped('test fixture: GLOBAL mcp.* settings have no tenant', ['ConfigSetting'], fn);
      await globalSettings(() =>
        prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } })
      );
      invalidateSettingsCache();
      const real = mcpOAuthGateOptions();
      expect(await real.getSettings()).toEqual({ enabled: false, writeToolsEnabled: false });
      await globalSettings(() =>
        prisma.configSetting.createMany({
          data: [
            { key: 'mcp.enabled', scope: 'GLOBAL', value: true },
            { key: 'mcp.writeToolsEnabled', scope: 'GLOBAL', value: true },
          ],
        })
      );
      invalidateSettingsCache();
      expect(await real.getSettings()).toEqual({ enabled: true, writeToolsEnabled: true });
      await globalSettings(() =>
        prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } })
      );
      invalidateSettingsCache();
    });
  });

  describe('session JWT confusion', () => {
    it('does not put a JWT of the session user in a response header', async () => {
      const user = await makeUser();
      const res = await call('GET', '/api/auth/get-session', { cookie: user.cookie });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe(user.email);
      expect(res.headers['set-auth-jwt']).toBeUndefined();
    });

    it("denies a signed-in non-admin the plugin's client management", async () => {
      const user = await makeUser();
      const headers = new Headers({ cookie: user.cookie, origin: ORIGIN });
      // The plugin answers a refused privilege with 401. These calls skip the gate, so this is
      // the plugin's own default-deny, which is what backs the gate up.
      await expect(
        getAuth().api.createOAuthClient({ body: { redirect_uris: [REDIRECT] }, headers })
      ).rejects.toMatchObject({ statusCode: 401 });
      await expect(
        getAuth().api.adminCreateOAuthClient({ body: { redirect_uris: [REDIRECT] }, headers })
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(await prisma.oauthClient.count()).toBe(0);
    });
  });

  describe('schema', () => {
    it('makes only the arrays the plugin requires non-nullable', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ table_name: string; column_name: string; is_nullable: string }>
      >`
        SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'ARRAY'
          AND (table_name LIKE 'oauth\\_%' OR table_name = 'jwks')`;
      const notNull = rows
        .filter((r) => r.is_nullable === 'NO')
        .map((r) => `${r.table_name}.${r.column_name}`)
        .sort();
      expect(notNull).toEqual([
        'oauth_access_tokens.scopes',
        'oauth_clients.redirect_uris',
        'oauth_consents.scopes',
        'oauth_refresh_tokens.scopes',
      ]);
      expect(rows.length).toBeGreaterThan(notNull.length);
    });

    it('seeds the MCP resource at boot with an explicit scope list, not an unrestricted or empty one', async () => {
      const resource = await prisma.oauthResource.findUniqueOrThrow({
        where: { identifier: MCP_RESOURCE },
      });
      expect(resource.allowedScopes).toEqual(['mcp:read', 'mcp:write', 'offline_access']);
      expect(resource.disabled).toBeFalsy();
    });
  });

  describe('signing keys', () => {
    const keyIds = async () =>
      ((await call('GET', '/api/auth/jwks')).json().keys as Array<{ kid: string }>).map(
        (k) => k.kid
      );

    it('rotates the signing key, and keeps the old one published for the grace window only', async () => {
      const first = await fullFlow();
      const oldKid = decodePart(first.tokens.access_token, 0).kid as string;
      expect(await keyIds()).toContain(oldKid);

      // The key's signing life has ended, but it is inside the grace window.
      await prisma.jwks.update({
        data: { expiresAt: new Date(Date.now() - 60_000) },
        where: { id: oldKid },
      });
      const second = await fullFlow();
      const newKid = decodePart(second.tokens.access_token, 0).kid as string;
      expect(newKid).not.toBe(oldKid);
      // Both are published, so a token signed just before rotation still verifies
      // and a verifier that meets the new kid can fetch it.
      expect(await keyIds()).toEqual(expect.arrayContaining([oldKid, newKid]));

      // Past the grace window the old key is withdrawn.
      await prisma.jwks.update({
        data: { expiresAt: new Date(Date.now() - (MCP_JWKS_GRACE_SECONDS + 60) * 1000) },
        where: { id: oldKid },
      });
      const after = await keyIds();
      expect(after).not.toContain(oldKid);
      expect(after).toContain(newKid);
    });

    it('stamps a lifetime on new keys', async () => {
      await fullFlow();
      const keys = await prisma.jwks.findMany();
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.expiresAt !== null)).toBe(true);
    });
  });
});
