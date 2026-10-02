import crypto from 'node:crypto';
import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import rateLimit from '@fastify/rate-limit';
import { hashPassword } from 'better-auth/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAuth, initAuth, MCP_RESOURCE } from '../lib/betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from '../lib/betterAuthHandler.js';
import { registerFormBodyParser } from '../lib/formBody.js';
import { mcpBridgePlugin } from '../lib/mcp/bridge.js';
import { MCP_CONSENT_SKEW_SECONDS } from '../lib/mcpOAuth.js';
import { mcpOAuthGate } from '../lib/mcpOAuthGate.js';
import { mcpOAuthGateOptions } from '../lib/mcpOAuthGateOptions.js';
import { mcpRouteOptions } from '../lib/mcpRouteOptions.js';
import { invalidateUserAuthCache, ipRateLimitKey } from '../plugins/auth.js';
import { mcpRoutes } from './mcp.js';

/**
 * The MCP endpoint against tokens the real authorization server issued, through the Prisma
 * adapter, against Postgres with the committed migrations applied. The verifier's database
 * checks (consent, client, user), its in-process read of the signing keys, and the
 * `mcp.enabled` switch are only meaningful against the real tables.
 *
 * Opt in with `MCP_OAUTH_PG_TEST=1` and a `DATABASE_URL` for a throwaway database that
 * `prisma migrate deploy` has been run against (it creates and deletes rows):
 *
 *   MCP_OAUTH_PG_TEST=1 DATABASE_URL=... yarn vitest run packages/gateway/src/routes/mcp.pg.test.ts
 */
const enabled = process.env.MCP_OAUTH_PG_TEST === '1';

const ORIGIN = 'http://localhost:3000';
const HOST = 'localhost:8080';
const REDIRECT = 'http://127.0.0.1:33333/cb';
const PASSWORD = 'correct horse battery staple';

const b64url = (buf: Buffer) => buf.toString('base64url');
const decodePart = (jwt: string, index: 0 | 1) =>
  JSON.parse(Buffer.from(jwt.split('.')[index] as string, 'base64url').toString('utf8'));

const initialize = {
  id: 1,
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    capabilities: {},
    clientInfo: { name: 'pg-test', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  },
};

describe.skipIf(!enabled)('MCP endpoint against Postgres', () => {
  let app: FastifyInstance;
  const settings = { enabled: true, writeToolsEnabled: false };
  let seq = 0;

  async function setSettings(next: Partial<typeof settings>) {
    Object.assign(settings, next);
    await runUnscoped(
      'test fixture: GLOBAL mcp.* settings have no tenant',
      ['ConfigSetting'],
      async () => {
        await prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } });
        await prisma.configSetting.createMany({
          data: [
            { key: 'mcp.enabled', scope: 'GLOBAL', value: settings.enabled },
            { key: 'mcp.writeToolsEnabled', scope: 'GLOBAL', value: settings.writeToolsEnabled },
          ],
        });
      }
    );
    invalidateSettingsCache();
  }

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    opts: {
      cookie?: string;
      json?: unknown;
      form?: Record<string, string>;
      headers?: Record<string, string>;
    } = {}
  ) =>
    app.inject({
      headers: {
        host: HOST,
        origin: ORIGIN,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...opts.headers,
      },
      method,
      ...(opts.json !== undefined ? { payload: opts.json as object } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
      remoteAddress: `198.51.100.${(seq++ % 250) + 1}`,
      url,
    });

  async function makeUser() {
    const email = `mcp-rs-${Date.now()}-${seq++}@example.test`;
    const user = await prisma.user.create({
      data: { email, emailVerified: true, isActive: true, name: 'MCP RS Test' },
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
    return { cookie, id: user.id };
  }

  async function registerClient() {
    const res = await call('POST', '/api/auth/oauth2/register', {
      json: {
        client_name: 'RS Test Client',
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

  /** Authorize, consent and exchange: the access token a client would hold. */
  async function issueToken(cookie: string, clientId: string, scope: string) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const auth = await call(
      'GET',
      `/api/auth/oauth2/authorize?${new URLSearchParams({
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
        response_type: 'code',
        scope,
        state: 's',
      })}`,
      { cookie }
    );
    expect(auth.statusCode, auth.body).toBe(302);
    let redirect = new URL(String(auth.headers.location));
    // A user who already consented to these scopes is not asked again.
    if (!redirect.searchParams.has('code')) {
      const consent = await call('POST', '/api/auth/oauth2/consent', {
        cookie,
        json: { accept: true, oauth_query: redirect.search.slice(1) },
      });
      expect(consent.statusCode, consent.body).toBe(200);
      redirect = new URL(consent.json().url ?? consent.json().redirect_uri);
    }
    const tokens = await call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        code: redirect.searchParams.get('code') as string,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
        resource: MCP_RESOURCE,
      },
    });
    expect(tokens.statusCode, tokens.body).toBe(200);
    return tokens.json().access_token as string;
  }

  async function connect(scope = 'mcp:read offline_access') {
    const user = await makeUser();
    const clientId = await registerClient();
    const token = await issueToken(user.cookie, clientId, scope);
    return { clientId, token, user };
  }

  const mcp = (
    token: string | null,
    body: unknown = initialize,
    headers: Record<string, string> = {}
  ) =>
    app.inject({
      headers: {
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        ...headers,
      },
      method: 'POST',
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${(seq++ % 250) + 1}`,
      url: '/api/v1/mcp',
    });

  async function reset() {
    await setSettings({ enabled: true, writeToolsEnabled: false });
    await prisma.oauthAccessToken.deleteMany();
    await prisma.oauthRefreshToken.deleteMany();
    await prisma.oauthConsent.deleteMany();
    await prisma.oauthClient.deleteMany();
  }

  beforeAll(async () => {
    await initAuth();
    app = Fastify();
    registerFormBodyParser(app);
    await app.register(rateLimit, {
      keyGenerator: ipRateLimitKey,
      max: 10_000,
      timeWindow: '1 minute',
    });
    await app.register(mcpOAuthGate, mcpOAuthGateOptions());
    registerBetterAuthRoutes(app, createBetterAuthHandler());
    const options = mcpRouteOptions();
    await app.register(mcpBridgePlugin, { verifier: options.verifier });
    await app.register(mcpRoutes, options);
    await app.ready();
  }, 60_000);

  beforeEach(reset);

  afterAll(async () => {
    await reset();
    await prisma.user.deleteMany({ where: { email: { endsWith: '@example.test' } } });
    await app?.close();
  });

  it('serves a token the authorization server issued: initialize and the read tools', async () => {
    const { token } = await connect();
    const header = decodePart(token, 0);
    expect(header.typ).toBe('at+jwt');

    const init = await mcp(token);
    expect(init.statusCode, init.body).toBe(200);
    expect(init.body).toContain('"serverInfo":{"name":"auto-swe"');

    const list = await mcp(
      token,
      { id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} },
      {
        'mcp-protocol-version': '2025-06-18',
      }
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain('"name":"list_repositories"');
  });

  it('serves the same token to a modern-envelope request as plain JSON', async () => {
    const { token } = await connect();
    const res = await mcp(
      token,
      {
        id: 3,
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'm', version: '1' },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          },
        },
      },
      { 'mcp-method': 'tools/list', 'mcp-protocol-version': '2026-07-28' }
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/^application\/json/);
    expect(
      res
        .json()
        .result.tools.map((t: { name: string }) => t.name)
        .sort()
    ).toEqual([
      'get_run',
      'list_pending_human_steps',
      'list_repositories',
      'list_runs',
      'list_work_requests',
    ]);
  });

  describe('credentials that are not an MCP access token', () => {
    it('refuses no token, an opaque token and a personal access token', async () => {
      expect((await mcp(null)).statusCode).toBe(401);
      expect((await mcp('o9p8a7q6u5e4t3o2k1e0n')).statusCode).toBe(401);
      expect((await mcp('ats_0123456789abcdef0123456789abcdef')).statusCode).toBe(401);
    });

    it('refuses a JWT the same key signed for another purpose: the session-to-JWT token', async () => {
      const { user } = await connect();
      // The jwt plugin's own session-token JWT: signed by the very key that signs access tokens,
      // so only the type and the audience tell it apart.
      const { headers } = await import('better-auth/node').then((m) => ({
        headers: m.fromNodeHeaders({ cookie: user.cookie }),
      }));
      const minted = (await getAuth().api.getToken({ headers })) as { token: string };
      expect(minted.token.split('.')).toHaveLength(3);
      expect((await mcp(minted.token)).statusCode).toBe(401);
    });

    it('refuses a token of the right shape signed by another key', async () => {
      const { token } = await connect();
      const [h, p] = token.split('.') as [string, string];
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const forged = `${h}.${p}.${b64url(crypto.sign(null, Buffer.from(`${h}.${p}`), privateKey))}`;
      expect((await mcp(forged)).statusCode).toBe(401);
    });
  });

  describe('state that outlives the token', () => {
    it('refuses a token whose consent was revoked, on the next call', async () => {
      const { clientId, token, user } = await connect();
      expect((await mcp(token)).statusCode).toBe(200);
      await prisma.oauthConsent.deleteMany({ where: { clientId, userId: user.id } });
      const res = await mcp(token);
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    });

    it('keys the consent on the user and the client together', async () => {
      // One user, two clients: revoking one app leaves the other.
      const user = await makeUser();
      const clientA = await registerClient();
      const clientB = await registerClient();
      const tokenA = await issueToken(user.cookie, clientA, 'mcp:read offline_access');
      const tokenB = await issueToken(user.cookie, clientB, 'mcp:read offline_access');
      expect([(await mcp(tokenA)).statusCode, (await mcp(tokenB)).statusCode]).toEqual([200, 200]);
      await prisma.oauthConsent.deleteMany({ where: { clientId: clientA, userId: user.id } });
      expect([(await mcp(tokenA)).statusCode, (await mcp(tokenB)).statusCode]).toEqual([401, 200]);

      // Two users, one client: revoking one user's grant leaves the other's.
      const user1 = await makeUser();
      const user2 = await makeUser();
      const shared = await registerClient();
      const token1 = await issueToken(user1.cookie, shared, 'mcp:read offline_access');
      const token2 = await issueToken(user2.cookie, shared, 'mcp:read offline_access');
      expect([(await mcp(token1)).statusCode, (await mcp(token2)).statusCode]).toEqual([200, 200]);
      await prisma.oauthConsent.deleteMany({ where: { clientId: shared, userId: user1.id } });
      expect([(await mcp(token1)).statusCode, (await mcp(token2)).statusCode]).toEqual([401, 200]);

      // Cross pair: a token for (user 2, client B) is not carried by user 2's consent for the
      // shared client, nor by another user's consent for B.
      const tokenX = await issueToken(user2.cookie, clientB, 'mcp:read offline_access');
      expect((await mcp(tokenX)).statusCode).toBe(200);
      await prisma.oauthConsent.deleteMany({ where: { clientId: clientB, userId: user2.id } });
      expect((await mcp(tokenX)).statusCode).toBe(401);
      expect((await mcp(token2)).statusCode).toBe(200);
      expect((await mcp(tokenB)).statusCode).toBe(200);
    });

    it('refuses a token older than the last consent, and accepts one issued after it', async () => {
      await setSettings({ writeToolsEnabled: true });
      const { clientId, token, user } = await connect();
      expect((await mcp(token)).statusCode).toBe(200);
      // A step-up: the same client and user consent again, to more. A token issued within the
      // verifier's skew tolerance of the consent survives it, so let that pass.
      await new Promise((resolve) => setTimeout(resolve, (MCP_CONSENT_SKEW_SECONDS + 1) * 1000));
      const fresh = await issueToken(user.cookie, clientId, 'mcp:read mcp:write offline_access');
      expect((await mcp(token)).statusCode).toBe(401);
      expect((await mcp(fresh)).statusCode).toBe(200);
    }, 30_000);

    it('refuses a token minted before a consent that was deleted and recreated, and takes a token issued after it', async () => {
      const { clientId, token, user } = await connect();
      expect((await mcp(token)).statusCode).toBe(200);
      const old = await prisma.oauthConsent.findFirstOrThrow({
        where: { clientId, userId: user.id },
      });
      // Revocation deletes the row; a later consent creates a new one (new createdAt).
      await prisma.oauthConsent.deleteMany({ where: { clientId, userId: user.id } });
      expect((await mcp(token)).statusCode).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, (MCP_CONSENT_SKEW_SECONDS + 1) * 1000));
      const { id: _id, ...rest } = old;
      const recreated = await prisma.oauthConsent.create({
        data: { ...rest, createdAt: new Date(), updatedAt: new Date() },
      });
      expect(recreated.createdAt.getTime()).toBeGreaterThan(old.createdAt.getTime());
      // Same user, client and scopes, but the token predates the current consent.
      expect((await mcp(token)).statusCode).toBe(401);
      // A token issued under the recreated consent is accepted at once.
      const fresh = await issueToken(user.cookie, clientId, 'mcp:read offline_access');
      expect((await mcp(fresh)).statusCode).toBe(200);
    }, 30_000);

    it('keeps a token valid when the user is not asked to consent again', async () => {
      const { clientId, token, user } = await connect();
      const again = await issueToken(user.cookie, clientId, 'mcp:read offline_access');
      expect((await mcp(token)).statusCode).toBe(200);
      expect((await mcp(again)).statusCode).toBe(200);
    });

    it('refuses a token when the consent row is stamped later than the token, beyond the skew', async () => {
      const { clientId, token } = await connect();
      await prisma.oauthConsent.updateMany({
        data: { updatedAt: new Date(Date.now() + 60_000) },
        where: { clientId },
      });
      expect((await mcp(token)).statusCode).toBe(401);
    });

    it('refuses a token once the user is deactivated', async () => {
      const { token, user } = await connect();
      expect((await mcp(token)).statusCode).toBe(200);
      await prisma.user.update({ data: { isActive: false }, where: { id: user.id } });
      invalidateUserAuthCache(user.id);
      expect((await mcp(token)).statusCode).toBe(401);
    });

    it('refuses a token once the client is disabled', async () => {
      const { clientId, token } = await connect();
      expect((await mcp(token)).statusCode).toBe(200);
      await prisma.oauthClient.update({ data: { disabled: true }, where: { clientId } });
      expect((await mcp(token)).statusCode).toBe(401);
    });
  });

  describe('scopes', () => {
    it('drops mcp:write once writes are switched off, and keeps the read the token also holds', async () => {
      await setSettings({ writeToolsEnabled: true });
      const { token } = await connect('mcp:read mcp:write offline_access');
      const { verifier } = mcpRouteOptions();
      expect((await verifier.verifyAccessToken(token)).scopes).toEqual(['mcp:read', 'mcp:write']);

      await setSettings({ writeToolsEnabled: false });
      expect((await verifier.verifyAccessToken(token)).scopes).toEqual(['mcp:read']);
      expect((await mcp(token)).statusCode).toBe(200);
    });
  });

  describe('mcp.enabled, flipped at runtime', () => {
    it('turns the endpoint and its metadata off and on without a restart', async () => {
      const { token } = await connect();
      const metadata = () =>
        call('GET', '/.well-known/oauth-protected-resource/api/v1/mcp').then((r) => r.statusCode);
      expect([(await mcp(token)).statusCode, await metadata()]).toEqual([200, 200]);

      await setSettings({ enabled: false });
      expect([(await mcp(token)).statusCode, await metadata()]).toEqual([404, 404]);

      await setSettings({ enabled: true });
      expect([(await mcp(token)).statusCode, await metadata()]).toEqual([200, 200]);
    });

    it('serves metadata that points at the issuer the tokens carry', async () => {
      const { token } = await connect();
      const doc = (await call('GET', '/.well-known/oauth-protected-resource/api/v1/mcp')).json();
      expect(doc.resource).toBe(MCP_RESOURCE);
      expect(doc.authorization_servers).toEqual([decodePart(token, 1).iss]);
    });
  });

  describe('signing keys', () => {
    it('verifies a token signed by a key the verifier has not read yet, after the old one expires', async () => {
      const { token: first, user, clientId } = await connect();
      expect((await mcp(first)).statusCode).toBe(200); // warms the key cache with the current key
      const firstKid = decodePart(first, 0).kid;

      // The plugin signs with the newest live key; an expired one makes it create another.
      await prisma.jwks.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const second = await issueToken(user.cookie, clientId, 'mcp:read offline_access');
      expect(decodePart(second, 0).kid).not.toBe(firstKid);

      expect((await mcp(second)).statusCode).toBe(200);
      // The retired key is still published, so a token it signed keeps verifying.
      expect((await mcp(first)).statusCode).toBe(200);
    });
  });
});
