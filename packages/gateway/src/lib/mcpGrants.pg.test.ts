import crypto from 'node:crypto';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import rateLimit from '@fastify/rate-limit';
import { hashPassword } from 'better-auth/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipRateLimitKey } from '../plugins/auth.js';
import { meRoutes } from '../routes/me.js';
import { initAuth, MCP_RESOURCE } from './betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './betterAuthHandler.js';
import { registerFormBodyParser } from './formBody.js';
import { mcpConsentAudit } from './mcpConsentAudit.js';
import { revokeMcpGrants } from './mcpGrants.js';
import { mcpOAuthGate } from './mcpOAuthGate.js';
import { mcpConsentAuditOptions, mcpOAuthGateOptions } from './mcpOAuthGateOptions.js';

/**
 * Consent, the login hand-off and durable revocation, end to end against Postgres through the
 * Prisma adapter (the memory adapter would not show how the provider's rows behave).
 *
 * Opt in with `MCP_OAUTH_PG_TEST=1` and a `DATABASE_URL` pointing at a throwaway database that
 * `prisma migrate deploy` has been run against; see `mcpOAuthServer.pg.test.ts`.
 */
const enabled = process.env.MCP_OAUTH_PG_TEST === '1';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:8080';
const REDIRECT = 'http://127.0.0.1:33333/cb';
const PASSWORD = 'correct horse battery staple';

const b64url = (buf: Buffer) => buf.toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), verifier };
};

/**
 * The `oauth_query` the real better-auth client plugin would attach to a sign-in request made
 * from a page at `search`: the signed parameters only. The login page does the same.
 */
async function pluginOAuthQuery(search: string): Promise<string | undefined> {
  const hook = oauthProviderClient().fetchPlugins[0]?.hooks?.onRequest;
  const ctx = {
    body: JSON.stringify({}),
    headers: new Headers({ 'content-type': 'application/json' }),
    method: 'POST',
  } as { body: string; headers: Headers; method: string };
  vi.stubGlobal('window', { location: { search } });
  try {
    await hook?.(ctx as never);
  } finally {
    vi.unstubAllGlobals();
  }
  return (JSON.parse(ctx.body) as { oauth_query?: string }).oauth_query;
}

describe.skipIf(!enabled)('MCP grants against Postgres', () => {
  let app: FastifyInstance;
  let me: FastifyInstance;
  const settings = { enabled: true, writeToolsEnabled: false };
  let seq = 0;

  const globalSettings = <T>(fn: () => Promise<T>) =>
    runUnscoped('test fixture: GLOBAL mcp.* settings have no tenant', ['ConfigSetting'], fn);
  async function setSettings(next: Partial<typeof settings>) {
    Object.assign(settings, next);
    await globalSettings(async () => {
      await prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } });
      await prisma.configSetting.createMany({
        data: [
          { key: 'mcp.enabled', scope: 'GLOBAL', value: settings.enabled },
          { key: 'mcp.writeToolsEnabled', scope: 'GLOBAL', value: settings.writeToolsEnabled },
        ],
      });
    });
    invalidateSettingsCache();
  }

  const call = (
    method: 'GET' | 'POST',
    url: string,
    opts: {
      cookie?: string;
      json?: unknown;
      form?: Record<string, string>;
      origin?: string | null;
    } = {}
  ) =>
    app.inject({
      headers: {
        host: HOST,
        ...(opts.origin === null ? {} : { origin: opts.origin ?? ORIGIN }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      method,
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
      remoteAddress: `198.51.100.${(seq++ % 250) + 1}`,
      url,
    });

  /** The REST routes the settings page calls, authenticated as `userId`. */
  const rest = (method: 'GET' | 'DELETE', url: string, userId: string) =>
    me.inject({ headers: { authorization: `Bearer ${userId}` }, method, url });

  async function makeUser(opts: { active?: boolean } = {}) {
    const email = `grants-${Date.now()}-${seq++}@example.test`;
    const user = await prisma.user.create({
      data: { email, emailVerified: true, isActive: opts.active ?? true, name: 'Grants Test' },
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

  async function registerClient(name = 'Test MCP Client') {
    const res = await call('POST', '/api/auth/oauth2/register', {
      json: {
        client_name: name,
        grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT],
        response_types: ['code'],
        scope: 'mcp:read mcp:write offline_access',
        token_endpoint_auth_method: 'none',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().client_id as string;
  }

  const authorizeUrl = (clientId: string, challenge: string, scope: string) =>
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT,
      resource: MCP_RESOURCE,
      response_type: 'code',
      scope,
      state: 'st-1',
    }).toString()}`;

  const consent = (cookie: string, consentSearch: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/auth/oauth2/consent', {
      cookie,
      json: { accept: true, oauth_query: consentSearch.replace(/^\?/, ''), ...extra },
    });

  const exchange = (clientId: string, code: string, verifier: string) =>
    call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
      },
    });

  const refresh = (clientId: string, token: string) =>
    call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token,
        resource: MCP_RESOURCE,
      },
    });

  /** Authorize and consent (signed in): the code the client would be redirected with. */
  async function authorizeCode(
    cookie: string,
    clientId: string,
    scope = 'mcp:read offline_access'
  ) {
    const { challenge, verifier } = pkce();
    const auth = await call('GET', authorizeUrl(clientId, challenge, scope), { cookie });
    expect(auth.statusCode, auth.body).toBe(302);
    const next = new URL(String(auth.headers.location));
    // An app that already holds a consent is sent straight back with a code.
    if (next.origin + next.pathname === REDIRECT) {
      return { code: next.searchParams.get('code') as string, verifier };
    }
    const accepted = await consent(cookie, next.search);
    expect(accepted.statusCode, accepted.body).toBe(200);
    return { code: new URL(accepted.json().url).searchParams.get('code') as string, verifier };
  }

  /** Authorize, consent, exchange: the tokens a connected client holds. */
  async function connect(cookie: string, clientId: string, scope = 'mcp:read offline_access') {
    const { code, verifier } = await authorizeCode(cookie, clientId, scope);
    const tokens = await exchange(clientId, code, verifier);
    expect(tokens.statusCode, tokens.body).toBe(200);
    return tokens.json() as { access_token: string; refresh_token: string };
  }

  async function reset() {
    await setSettings({ enabled: true, writeToolsEnabled: false });
    await prisma.oauthAccessToken.deleteMany();
    await prisma.oauthRefreshToken.deleteMany();
    await prisma.oauthConsent.deleteMany();
    await prisma.oauthClient.deleteMany();
    await prisma.configAuditLog.deleteMany({ where: { entityType: 'McpGrant' } });
  }

  beforeAll(async () => {
    await initAuth();
    app = Fastify();
    registerFormBodyParser(app);
    app.decorate('prisma', prisma);
    await app.register(rateLimit, {
      keyGenerator: ipRateLimitKey,
      max: 10_000,
      timeWindow: '1 minute',
    });
    await app.register(mcpOAuthGate, mcpOAuthGateOptions());
    await app.register(mcpConsentAudit, mcpConsentAuditOptions());
    registerBetterAuthRoutes(app, createBetterAuthHandler());
    await app.ready();

    // The REST routes under test, with the bearer token standing in for the user id.
    me = Fastify();
    me.setValidatorCompiler(validatorCompiler);
    me.setSerializerCompiler(serializerCompiler);
    me.decorate('prisma', prisma);
    me.decorate('auth', {
      verifyAccessToken: (token: string) => ({
        exp: 9_999_999_999,
        iat: 0,
        role: 'ENGINEER',
        sub: token,
      }),
    } as never);
    await me.register(meRoutes, { prefix: '/api/v1/me' });
    await me.ready();
  }, 60_000);

  beforeEach(reset);

  afterAll(async () => {
    await reset();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@example.test' } } });
    await app?.close();
    await me?.close();
  });

  describe('login hand-off', () => {
    it('resumes an authorization started anonymously, through a sign-in that carries the signed query', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const { challenge, verifier } = pkce();

      // 1. The client's authorize request, with no session: the browser lands on /login.
      const auth = await call('GET', authorizeUrl(clientId, challenge, 'mcp:read offline_access'));
      expect(auth.statusCode).toBe(302);
      const login = new URL(String(auth.headers.location));
      expect(login.origin + login.pathname).toBe(`${ORIGIN}/login`);

      // 2. The login page signs in with the signed parameters of its own address attached,
      //    and a stray parameter of its own (`redirect`) that must not be.
      const oauthQuery = await pluginOAuthQuery(`${login.search}&redirect=%2F`);
      expect(oauthQuery).toBeTruthy();
      expect(new URLSearchParams(oauthQuery).has('redirect')).toBe(false);
      const signedIn = await call('POST', '/api/auth/sign-in/email', {
        json: { email: user.email, oauth_query: oauthQuery, password: PASSWORD },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);

      // 3. The sign-in response itself carries the next step: the consent page, signed.
      const next = new URL(signedIn.json().url);
      expect(next.origin + next.pathname).toBe(`${ORIGIN}/oauth/consent`);
      expect(next.searchParams.get('scope')).toBe('mcp:read offline_access');
      expect(next.searchParams.get('redirect_uri')).toBe(REDIRECT);
      const cookie = ([] as string[])
        .concat(signedIn.headers['set-cookie'] ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');

      // 4. The client's name is readable by the signed-in user, for the consent screen.
      const publicClient = await call(
        'GET',
        `/api/auth/oauth2/public-client?client_id=${clientId}`,
        { cookie }
      );
      expect(publicClient.statusCode, publicClient.body).toBe(200);
      expect(publicClient.json().client_name).toBe('Test MCP Client');

      // 5. Consent, narrowed to what the page offers, completes the authorization.
      const accepted = await consent(cookie, next.search, { scope: 'mcp:read offline_access' });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const redirect = new URL(accepted.json().url);
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
      const tokens = await exchange(
        clientId,
        redirect.searchParams.get('code') as string,
        verifier
      );
      expect(tokens.statusCode, tokens.body).toBe(200);
    });

    it('resumes from the consent address too, for a browser that reached the page signed out', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      // The consent address the plugin issues (here via a signed-in authorize)...
      const auth = await call('GET', authorizeUrl(clientId, pkce().challenge, 'mcp:read'), {
        cookie: user.cookie,
      });
      const consentSearch = new URL(String(auth.headers.location)).search;
      // ...is what the page's "Sign in" link hands to /login, which signs in with it.
      const oauthQuery = await pluginOAuthQuery(consentSearch);
      expect(oauthQuery).toBeTruthy();
      const signedIn = await call('POST', '/api/auth/sign-in/email', {
        json: { email: user.email, oauth_query: oauthQuery, password: PASSWORD },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const next = new URL(signedIn.json().url);
      expect(next.origin + next.pathname).toBe(`${ORIGIN}/oauth/consent`);
    });

    it('sends a user who is already signed in straight to the consent page', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const auth = await call('GET', authorizeUrl(clientId, pkce().challenge, 'mcp:read'), {
        cookie: user.cookie,
      });
      const next = new URL(String(auth.headers.location));
      expect(next.origin + next.pathname).toBe(`${ORIGIN}/oauth/consent`);
    });

    it('answers a denial with access_denied for the client, and stores nothing', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const auth = await call('GET', authorizeUrl(clientId, pkce().challenge, 'mcp:read'), {
        cookie: user.cookie,
      });
      const denied = await consent(user.cookie, new URL(String(auth.headers.location)).search, {
        accept: false,
      });
      const redirect = new URL(denied.json().url);
      expect(redirect.searchParams.get('error')).toBe('access_denied');
      expect(redirect.searchParams.get('iss')).toBeTruthy();
      expect(await prisma.oauthConsent.count()).toBe(0);
      expect(await prisma.configAuditLog.count({ where: { entityType: 'McpGrant' } })).toBe(0);
    });
  });

  describe('listing', () => {
    it('lists the caller’s grants with the client name and redirect, and nobody else’s', async () => {
      const mine = await makeUser();
      const other = await makeUser();
      const a = await registerClient('Claude Code');
      const b = await registerClient('Someone Else’s Client');
      await connect(mine.cookie, a);
      await connect(other.cookie, b);

      const res = await rest('GET', '/api/v1/me/mcp-grants', mine.id);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        clientId: a,
        clientName: 'Claude Code',
        redirectUris: [REDIRECT],
        scopes: ['mcp:read', 'offline_access'],
      });
      expect(body.mcp).toEqual({ enabled: true, writeToolsEnabled: false });
    });
  });

  describe('revocation', () => {
    it('makes a refresh after revoke invalid_grant, and marks the stored tokens revoked', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const tokens = await connect(user.cookie, clientId);
      // Every token the server issues is a JWT, so nothing stores an access token. The provider
      // can store one for an opaque token, and revocation has to cover it.
      const stored = await prisma.oauthAccessToken.create({
        data: {
          clientId,
          expiresAt: new Date(Date.now() + 600_000),
          scopes: ['mcp:read'],
          token: `opaque-${crypto.randomUUID()}`,
          userId: user.id,
        },
      });

      const res = await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);
      expect(res.statusCode, res.body).toBe(204);
      expect(
        (await prisma.oauthAccessToken.findUniqueOrThrow({ where: { id: stored.id } })).revoked
      ).not.toBeNull();

      const refused = await refresh(clientId, tokens.refresh_token);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toBe('invalid_grant');
      expect(refused.json().access_token).toBeUndefined();

      expect(await prisma.oauthConsent.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await prisma.oauthRefreshToken.count({ where: { revoked: null, userId: user.id } })
      ).toBe(0);
      expect(
        await prisma.oauthAccessToken.count({ where: { revoked: null, userId: user.id } })
      ).toBe(0);
      expect((await rest('GET', '/api/v1/me/mcp-grants', user.id)).json().data).toEqual([]);
    });

    it('is not undone by consenting again: the old refresh token stays dead, a new one works', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const old = await connect(user.cookie, clientId);
      await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);

      const fresh = await connect(user.cookie, clientId);

      // The new grant works first: presenting a revoked refresh token is treated as theft
      // by the provider, which then invalidates every refresh token of the pair.
      const ok = await refresh(clientId, fresh.refresh_token);
      expect(ok.statusCode, ok.body).toBe(200);
      const revived = await refresh(clientId, old.refresh_token);
      expect(revived.statusCode).toBe(400);
      expect(revived.json().error).toBe('invalid_grant');
      expect(revived.json().access_token).toBeUndefined();
    });

    it('kills an authorization code that was issued before the disconnect and not yet exchanged', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const held = await authorizeCode(user.cookie, clientId);

      expect((await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id)).statusCode).toBe(
        204
      );

      const res = await exchange(clientId, held.code, held.verifier);
      expect(res.statusCode).toBe(400);
      expect(res.json().access_token).toBeUndefined();
      expect(res.json().refresh_token).toBeUndefined();
      expect(await prisma.oauthRefreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it('does not let a code held through a disconnect come back with a later consent', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const held = await authorizeCode(user.cookie, clientId);
      await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);

      // The user connects the app again, later.
      const fresh = await connect(user.cookie, clientId);

      const stale = await exchange(clientId, held.code, held.verifier);
      expect(stale.statusCode).toBe(400);
      expect(stale.json().refresh_token).toBeUndefined();
      expect((await refresh(clientId, fresh.refresh_token)).statusCode).toBe(200);
    });

    it('only removes the codes of the pair being revoked', async () => {
      const user = await makeUser();
      const other = await makeUser();
      const a = await registerClient('A');
      const b = await registerClient('B');
      const keptB = await authorizeCode(user.cookie, b);
      const keptOther = await authorizeCode(other.cookie, a);
      await authorizeCode(user.cookie, a);

      await rest('DELETE', `/api/v1/me/mcp-grants/${a}`, user.id);

      expect((await exchange(b, keptB.code, keptB.verifier)).statusCode).toBe(200);
      expect((await exchange(a, keptOther.code, keptOther.verifier)).statusCode).toBe(200);
    });

    it('does not remove another user’s pending code for the same client, even one that mentions this user', async () => {
      const a = await makeUser();
      const b = await makeUser();
      const clientId = await registerClient();
      await connect(a.cookie, clientId);
      const heldByB = await authorizeCode(b.cookie, clientId);
      // The pre-filter on the user's id would catch B's code if it merely quoted A's id (a
      // `state` the client chose, say); only the code's own owner may decide.
      const row = await prisma.verification.findFirstOrThrow({
        where: { value: { contains: b.id } },
      });
      const value = JSON.parse(row.value);
      value.query.state = a.id;
      await prisma.verification.update({
        data: { value: JSON.stringify(value) },
        where: { id: row.id },
      });

      await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, a.id);

      expect(await prisma.verification.count({ where: { id: row.id } })).toBe(1);
      expect((await exchange(clientId, heldByB.code, heldByB.verifier)).statusCode).toBe(200);
    });

    it('records the revocation when tokens outlived their consent, against the user', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      await connect(user.cookie, clientId);
      await prisma.oauthConsent.deleteMany({ where: { userId: user.id } });
      await prisma.configAuditLog.deleteMany({ where: { entityType: 'McpGrant' } });

      const res = await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);
      expect(res.statusCode).toBe(204);

      const row = await prisma.configAuditLog.findFirstOrThrow({
        where: { action: 'DELETE', entityType: 'McpGrant' },
      });
      expect(row).toMatchObject({ actorId: user.id, entityId: user.id });
      expect(row.beforeJson).toMatchObject({ clientId, consent: null, refreshTokens: 1 });
    });

    it('leaves the same user’s other clients, and other users’ grants to the same client, alone', async () => {
      const mine = await makeUser();
      const other = await makeUser();
      const a = await registerClient('A');
      const b = await registerClient('B');
      await connect(mine.cookie, a);
      const keptB = await connect(mine.cookie, b);
      const keptOther = await connect(other.cookie, a);

      await rest('DELETE', `/api/v1/me/mcp-grants/${a}`, mine.id);

      expect((await refresh(b, keptB.refresh_token)).statusCode).toBe(200);
      expect((await refresh(a, keptOther.refresh_token)).statusCode).toBe(200);
    });

    it('cannot be used to revoke or discover another user’s grant', async () => {
      const owner = await makeUser();
      const intruder = await makeUser();
      const clientId = await registerClient();
      const tokens = await connect(owner.cookie, clientId);

      const res = await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, intruder.id);
      expect(res.statusCode).toBe(404);
      expect((await refresh(clientId, tokens.refresh_token)).statusCode).toBe(200);
      expect(await prisma.oauthConsent.count({ where: { userId: owner.id } })).toBe(1);
    });

    it('works while MCP is switched off, and still holds when it is switched back on', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const tokens = await connect(user.cookie, clientId);
      await setSettings({ enabled: false });

      expect((await rest('GET', '/api/v1/me/mcp-grants', user.id)).statusCode).toBe(200);
      const res = await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);
      expect(res.statusCode).toBe(204);

      await setSettings({ enabled: true });
      expect((await refresh(clientId, tokens.refresh_token)).json().error).toBe('invalid_grant');
    });

    it('revokes every grant of a deactivated user, and the account cannot refresh', async () => {
      const user = await makeUser();
      const a = await registerClient('A');
      const b = await registerClient('B');
      const tokenA = await connect(user.cookie, a);
      const tokenB = await connect(user.cookie, b);
      const heldCode = await authorizeCode(user.cookie, a);

      // What PATCH /api/v1/users/:id does when it deactivates an account.
      await prisma.user.update({ data: { isActive: false }, where: { id: user.id } });
      await revokeMcpGrants(prisma, { actorId: user.id, userId: user.id });

      expect(await prisma.oauthConsent.count({ where: { userId: user.id } })).toBe(0);
      expect(
        await prisma.oauthRefreshToken.count({ where: { revoked: null, userId: user.id } })
      ).toBe(0);
      expect((await refresh(a, tokenA.refresh_token)).statusCode).toBe(400);
      expect((await refresh(b, tokenB.refresh_token)).statusCode).toBe(400);
      // A code the account had not yet exchanged is gone with the rest.
      await prisma.user.update({ data: { isActive: true }, where: { id: user.id } });
      expect((await exchange(a, heldCode.code, heldCode.verifier)).statusCode).toBe(400);
      await prisma.user.update({ data: { isActive: false }, where: { id: user.id } });

      // Reactivating the account does not bring them back: the tokens are revoked, not merely refused.
      await prisma.user.update({ data: { isActive: true }, where: { id: user.id } });
      const back = await refresh(a, tokenA.refresh_token);
      expect(back.statusCode).toBe(400);
      expect(back.json().error).toBe('invalid_grant');
    });

    it('reports nothing to revoke when there is no grant', async () => {
      const user = await makeUser();
      expect(
        await revokeMcpGrants(prisma, { actorId: user.id, clientId: 'nope', userId: user.id })
      ).toBe(false);
    });
  });

  describe('consent CSRF', () => {
    it('refuses a consent decision from a foreign or missing Origin, and issues nothing', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const auth = await call('GET', authorizeUrl(clientId, pkce().challenge, 'mcp:read'), {
        cookie: user.cookie,
      });
      const search = new URL(String(auth.headers.location)).search.slice(1);

      for (const origin of ['https://evil.example', null]) {
        const res = await call('POST', '/api/auth/oauth2/consent', {
          cookie: user.cookie,
          json: { accept: true, oauth_query: search },
          origin,
        });
        expect(res.statusCode, String(origin)).toBe(403);
      }
      expect(await prisma.oauthConsent.count()).toBe(0);

      // The web app's own origin is accepted.
      const ok = await call('POST', '/api/auth/oauth2/consent', {
        cookie: user.cookie,
        json: { accept: true, oauth_query: search },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });

  describe('audit', () => {
    it('records the grant and the revocation, attributed to who did it', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      await connect(user.cookie, clientId);

      // The grant is recorded after the response is sent.
      await vi.waitFor(async () => {
        expect(await prisma.configAuditLog.count({ where: { entityType: 'McpGrant' } })).toBe(1);
      });
      const granted = await prisma.configAuditLog.findFirstOrThrow({
        where: { entityType: 'McpGrant' },
      });
      expect(granted).toMatchObject({ action: 'CREATE', actorId: user.id });
      expect(granted.afterJson).toEqual({
        clientId,
        scopes: ['mcp:read', 'offline_access'],
        userId: user.id,
      });

      await rest('DELETE', `/api/v1/me/mcp-grants/${clientId}`, user.id);
      const revoked = await prisma.configAuditLog.findFirstOrThrow({
        where: { action: 'DELETE', entityType: 'McpGrant' },
      });
      expect(revoked.actorId).toBe(user.id);
      expect(revoked.entityId).toBe(granted.entityId);
      expect(revoked.beforeJson).toMatchObject({ clientId, userId: user.id });
    });

    it('does not record a grant for a denial', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      const auth = await call('GET', authorizeUrl(clientId, pkce().challenge, 'mcp:read'), {
        cookie: user.cookie,
      });
      await consent(user.cookie, new URL(String(auth.headers.location)).search, { accept: false });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await prisma.configAuditLog.count({ where: { entityType: 'McpGrant' } })).toBe(0);
    });
  });

  describe('the provider’s own consent management', () => {
    it('is not reachable, so revokeMcpGrants is the only way a consent is deleted', async () => {
      const user = await makeUser();
      const clientId = await registerClient();
      await connect(user.cookie, clientId);
      const row = await prisma.oauthConsent.findFirstOrThrow({ where: { userId: user.id } });

      for (const [method, url] of [
        ['POST', '/api/auth/oauth2/delete-consent'],
        ['POST', '/api/auth/oauth2/update-consent'],
        ['GET', '/api/auth/oauth2/get-consents'],
        ['POST', '/api/auth/OAuth2/Delete-Consent'],
      ] as const) {
        const res = await call(method, url, {
          cookie: user.cookie,
          ...(method === 'POST' ? { json: { id: row.id } } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      expect(await prisma.oauthConsent.count({ where: { userId: user.id } })).toBe(1);
    });
  });
});
