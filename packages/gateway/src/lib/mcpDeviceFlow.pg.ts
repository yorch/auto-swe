import { invalidateSettingsCache } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import rateLimit from '@fastify/rate-limit';
import { hashPassword } from 'better-auth/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ipRateLimitKey } from '../plugins/auth.js';
import { mcpRoutes } from '../routes/mcp.js';
import { initAuth, MCP_RESOURCE } from './betterAuth.js';
import { createBetterAuthHandler, registerBetterAuthRoutes } from './betterAuthHandler.js';
import { registerFormBodyParser } from './formBody.js';
import { mcpBridgePlugin } from './mcp/bridge.js';
import { revokeMcpGrants } from './mcpGrants.js';
import { MCP_DEVICE_GRANT } from './mcpOAuth.js';
import { mcpOAuthGate } from './mcpOAuthGate.js';
import { mcpOAuthGateOptions } from './mcpOAuthGateOptions.js';
import { mcpRouteOptions } from './mcpRouteOptions.js';

const enabled = process.env.MCP_OAUTH_PG_TEST === '1';
const ORIGIN = 'http://localhost:3000';

describe.skipIf(!enabled)('MCP device authorization against Postgres', () => {
  let app: FastifyInstance;
  let seq = 0;
  const settings = { deviceFlowEnabled: true, enabled: true, writeToolsEnabled: false };
  async function setSettings(next: Partial<typeof settings>) {
    Object.assign(settings, next);
    await runUnscoped('GLOBAL MCP settings test fixture', ['ConfigSetting'], async () => {
      await prisma.configSetting.deleteMany({ where: { key: { startsWith: 'mcp.' } } });
      await prisma.configSetting.createMany({
        data: Object.entries(settings).map(([key, value]) => ({
          key: `mcp.${key}`,
          scope: 'GLOBAL',
          value,
        })),
      });
    });
    invalidateSettingsCache();
  }
  const call = (
    method: 'GET' | 'POST',
    url: string,
    opts: { cookie?: string; json?: object; form?: Record<string, string>; origin?: string } = {}
  ) =>
    app.inject({
      headers: {
        host: 'localhost:8080',
        origin: opts.origin ?? ORIGIN,
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      method,
      remoteAddress: `198.51.100.${(seq++ % 250) + 1}`,
      url,
      ...(opts.json ? { payload: opts.json } : {}),
      ...(opts.form ? { payload: new URLSearchParams(opts.form).toString() } : {}),
    });
  async function makeUser() {
    const email = `mcp-device-${Date.now()}-${seq++}@example.test`;
    const user = await prisma.user.create({
      data: { email, emailVerified: true, isActive: true, name: 'Device User' },
    });
    await prisma.account.create({
      data: {
        accountId: user.id,
        password: await hashPassword('device test password'),
        providerId: 'credential',
        userId: user.id,
      },
    });
    const login = await call('POST', '/api/auth/sign-in/email', {
      json: { email, password: 'device test password' },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    return { cookie, id: user.id };
  }
  async function registerClient() {
    const response = await call('POST', '/api/auth/oauth2/register', {
      json: {
        client_name: 'Device test client',
        grant_types: [MCP_DEVICE_GRANT, 'refresh_token'],
        // The provider schema requires a syntactically valid public-client redirect URI even
        // when authorization_code is not requested; device authorization never uses it.
        redirect_uris: ['http://127.0.0.1/device-test'],
        response_types: [],
        scope: 'mcp:read mcp:write offline_access',
        token_endpoint_auth_method: 'none',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().client_id as string;
  }
  const requestCode = (clientId: string, scope = 'mcp:read offline_access') =>
    call('POST', '/api/auth/device/code', {
      form: { client_id: clientId, resource: MCP_RESOURCE, scope },
    });
  const poll = (clientId: string, code: string) =>
    call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        device_code: code,
        grant_type: MCP_DEVICE_GRANT,
        resource: MCP_RESOURCE,
      },
    });
  const readyToPoll = (code: string) =>
    prisma.deviceCode.update({
      data: { lastPolledAt: new Date(Date.now() - 60_000) },
      where: { deviceCode: code },
    });
  async function prepare(scope = 'mcp:read offline_access') {
    const user = await makeUser();
    const clientId = await registerClient();
    const response = await requestCode(clientId, scope);
    expect(response.statusCode, response.body).toBe(200);
    const code = response.json() as {
      user_code: string;
      device_code: string;
      expires_in: number;
      interval: number;
      verification_uri: string;
      verification_uri_complete: string;
    };
    return { clientId, code, user };
  }
  async function review(cookie: string, userCode: string) {
    return call('GET', `/api/auth/device?user_code=${encodeURIComponent(userCode)}`, { cookie });
  }
  async function approve(cookie: string, userCode: string) {
    const verified = await review(cookie, userCode);
    expect(verified.statusCode, verified.body).toBe(200);
    return call('POST', '/api/auth/device/approve', { cookie, json: { userCode } });
  }
  async function reset() {
    await setSettings({ deviceFlowEnabled: true, enabled: true, writeToolsEnabled: false });
    await prisma.deviceCode.deleteMany();
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
    await setSettings({ deviceFlowEnabled: false });
    await prisma.user.deleteMany({ where: { email: { startsWith: 'mcp-device-' } } });
    await app?.close();
  });

  it('hides every device endpoint, device grant and discovery field while disabled', async () => {
    await setSettings({ deviceFlowEnabled: false });
    for (const path of [
      '/device/code',
      '/device',
      '/device/approve',
      '/device/deny',
      '/device/token',
    ]) {
      const res = await call(path === '/device' ? 'GET' : 'POST', `/api/auth${path}`, {
        json: path === '/device' ? undefined : {},
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    expect((await poll('client', 'code')).statusCode).toBe(404);
    const discovery = await call('GET', '/.well-known/oauth-authorization-server/api/auth');
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).not.toHaveProperty('device_authorization_endpoint');
    expect(discovery.json().grant_types_supported).not.toContain(MCP_DEVICE_GRANT);
  });
  it('accepts public device-only DCR and advertises the enabled endpoint', async () => {
    const clientId = await registerClient();
    expect(
      (await prisma.oauthClient.findUniqueOrThrow({ where: { clientId } })).grantTypes
    ).toEqual([MCP_DEVICE_GRANT, 'refresh_token']);
    const discovery = (
      await call('GET', '/.well-known/oauth-authorization-server/api/auth')
    ).json();
    expect(discovery.device_authorization_endpoint).toBe(
      'http://localhost:8080/api/auth/device/code'
    );
    expect(discovery.grant_types_supported).toContain(MCP_DEVICE_GRANT);
  });
  it.each([undefined, 'https://other.invalid/mcp'])(
    'refuses missing or incorrect resource %s',
    async (resource) => {
      const clientId = await registerClient();
      const res = await call('POST', '/api/auth/device/code', {
        form: { client_id: clientId, scope: 'mcp:read', ...(resource ? { resource } : {}) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_target');
    }
  );
  it('refuses write when disabled, invalid scopes and unregistered clients', async () => {
    const clientId = await registerClient();
    expect((await requestCode(clientId, 'mcp:write')).json().error).toBe('invalid_scope');
    expect((await requestCode(clientId, 'openid')).json().error).toBe('invalid_scope');
    expect((await requestCode('unknown')).json().error).toBe('invalid_client');
  });
  it('preserves plugin pending polling and slow_down', async () => {
    const { clientId, code } = await prepare();
    expect(code.expires_in).toBe(600);
    expect(code.interval).toBe(5);
    expect(code.verification_uri).toBe(`${ORIGIN}/device`);
    expect(new URL(code.verification_uri_complete).searchParams.get('user_code')).toBe(
      code.user_code
    );
    expect((await poll(clientId, code.device_code)).json().error).toBe('authorization_pending');
    expect((await poll(clientId, code.device_code)).json().error).toBe('slow_down');
    expect(
      (await prisma.deviceCode.findUniqueOrThrow({ where: { deviceCode: code.device_code } }))
        .pollingInterval
    ).toBeGreaterThan(5);
  });
  it('issues an audience-bound JWT usable at MCP, refreshes, and revokes it on disconnect', async () => {
    const { clientId, code, user } = await prepare();
    const details = await review(user.cookie, code.user_code);
    expect(details.json()).toMatchObject({
      client_id: clientId,
      resource: MCP_RESOURCE,
      scope: 'mcp:read offline_access',
    });
    const approved = await approve(user.cookie, code.user_code);
    expect(approved.statusCode, approved.body).toBe(200);
    const consent = await prisma.oauthConsent.findFirstOrThrow({
      where: { clientId, userId: user.id },
    });
    expect(consent.scopes).toEqual(['mcp:read', 'offline_access']);
    expect(
      await prisma.configAuditLog.count({
        where: { action: 'CREATE', actorId: user.id, entityId: consent.id },
      })
    ).toBe(1);
    const response = await poll(clientId, code.device_code);
    expect(response.statusCode, response.body).toBe(200);
    const tokens = response.json();
    expect(
      JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString()).aud
    ).toBe(MCP_RESOURCE);
    const mcp = await app.inject({
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      method: 'POST',
      payload: {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'device-test', version: '1' },
          protocolVersion: '2025-06-18',
        },
      },
      url: '/api/v1/mcp',
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.body).toContain('auto-swe');
    const refresh = await call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    expect(refresh.statusCode, refresh.body).toBe(200);
    expect(refresh.json().refresh_token).toBeTruthy();
    await revokeMcpGrants(prisma, { actorId: user.id, clientId, userId: user.id });
    const revoked = await call('POST', '/api/auth/oauth2/token', {
      form: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refresh.json().refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    expect(revoked.statusCode).toBe(400);
  });
  it('denies without creating a consent', async () => {
    const { clientId, code, user } = await prepare();
    await review(user.cookie, code.user_code);
    expect(
      (
        await call('POST', '/api/auth/device/deny', {
          cookie: user.cookie,
          json: { userCode: code.user_code },
        })
      ).statusCode
    ).toBe(200);
    expect((await poll(clientId, code.device_code)).json().error).toBe('access_denied');
    expect(await prisma.oauthConsent.count({ where: { clientId, userId: user.id } })).toBe(0);
  });
  it('refuses expired codes both at approval and exchange', async () => {
    const { clientId, code, user } = await prepare();
    await review(user.cookie, code.user_code);
    await prisma.deviceCode.update({
      data: { expiresAt: new Date(Date.now() - 1000) },
      where: { deviceCode: code.device_code },
    });
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: user.cookie,
          json: { userCode: code.user_code },
        })
      ).json().error
    ).toBe('expired_token');
    expect((await poll(clientId, code.device_code)).json().error).toBe('expired_token');
  });
  it('rejects client mismatch without consuming an approved code', async () => {
    const { clientId, code, user } = await prepare();
    expect((await approve(user.cookie, code.user_code)).statusCode).toBe(200);
    const other = await registerClient();
    const mismatch = await poll(other, code.device_code);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('invalid_grant');
    await readyToPoll(code.device_code);
    expect((await poll(clientId, code.device_code)).statusCode).toBe(200);
  });
  it('blocks first-party device/token even while enabled', async () => {
    const { code, clientId } = await prepare();
    expect(
      (
        await call('POST', '/api/auth/device/token', {
          json: { client_id: clientId, device_code: code.device_code },
        })
      ).statusCode
    ).toBe(404);
  });
  it('requires a signed-in active owner, trusted origin, and exact requested scopes', async () => {
    await setSettings({ writeToolsEnabled: true });
    const { code, user } = await prepare('mcp:read mcp:write offline_access');
    expect(
      (await call('POST', '/api/auth/device/approve', { json: { userCode: code.user_code } }))
        .statusCode
    ).toBe(401);
    await review(user.cookie, code.user_code);
    const other = await makeUser();
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: other.cookie,
          json: { userCode: code.user_code },
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: user.cookie,
          json: { userCode: code.user_code },
          origin: 'https://evil.invalid',
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: user.cookie,
          json: { scope: 'mcp:read', userCode: code.user_code },
        })
      ).statusCode
    ).toBe(400);
    await setSettings({ writeToolsEnabled: false });
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: user.cookie,
          json: { userCode: code.user_code },
        })
      ).json().error
    ).toBe('invalid_scope');
    await setSettings({ writeToolsEnabled: true });
    await prisma.user.update({ data: { isActive: false }, where: { id: user.id } });
    expect(
      (
        await call('POST', '/api/auth/device/approve', {
          cookie: user.cookie,
          json: { userCode: code.user_code },
        })
      ).statusCode
    ).toBe(403);
  });
  it('grants all requested write scopes and replaces prior consent like authorization-code consent', async () => {
    await setSettings({ writeToolsEnabled: true });
    const { code, user, clientId } = await prepare('mcp:read mcp:write offline_access');
    await prisma.oauthConsent.create({
      data: {
        clientId,
        requestedUserInfoClaims: [],
        resources: [MCP_RESOURCE],
        scopes: ['mcp:read'],
        userId: user.id,
      },
    });
    expect((await approve(user.cookie, code.user_code)).statusCode).toBe(200);
    expect(
      (await prisma.oauthConsent.findFirstOrThrow({ where: { clientId, userId: user.id } })).scopes
    ).toEqual(['mcp:read', 'mcp:write', 'offline_access']);
    expect((await poll(clientId, code.device_code)).json().scope).toBe(
      'mcp:read mcp:write offline_access'
    );
  });
  it.each(['inactive', 'mcp-disabled', 'write-disabled'] as const)(
    'rechecks %s at shared issuance after approval',
    async (refusal) => {
      await setSettings({ writeToolsEnabled: true });
      const { code, user, clientId } = await prepare('mcp:read mcp:write offline_access');
      expect((await approve(user.cookie, code.user_code)).statusCode).toBe(200);
      if (refusal === 'inactive') {
        await prisma.user.update({ data: { isActive: false }, where: { id: user.id } });
      }
      if (refusal === 'mcp-disabled') {
        await setSettings({ enabled: false });
      }
      if (refusal === 'write-disabled') {
        await setSettings({ writeToolsEnabled: false });
      }
      const response = await poll(clientId, code.device_code);
      expect(response.statusCode, response.body).toBe(refusal === 'mcp-disabled' ? 404 : 400);
      if (refusal !== 'mcp-disabled') {
        expect(response.json().error).toBe('invalid_grant');
      }
      expect(await prisma.oauthRefreshToken.count({ where: { clientId, userId: user.id } })).toBe(
        0
      );
    }
  );
  it('invalidates pending and approved-but-unredeemed codes on disconnect', async () => {
    const { clientId, code, user } = await prepare();
    expect((await approve(user.cookie, code.user_code)).statusCode).toBe(200);
    const pending = (await requestCode(clientId)).json();
    await review(user.cookie, pending.user_code);
    await revokeMcpGrants(prisma, { actorId: user.id, clientId, userId: user.id });
    expect(await prisma.deviceCode.count({ where: { userId: user.id } })).toBe(0);
    expect((await poll(clientId, code.device_code)).json().error).toBe('invalid_grant');
    expect((await poll(clientId, pending.device_code)).json().error).toBe('invalid_grant');
    expect(await prisma.oauthConsent.count({ where: { clientId, userId: user.id } })).toBe(0);
  });
  it('rate-limits device code creation per IP, including invalid client attempts', async () => {
    const responses = [];
    for (let i = 0; i < 11; i++) {
      responses.push(
        await app.inject({
          headers: { host: 'localhost:8080' },
          method: 'POST',
          payload: { client_id: 'missing', resource: MCP_RESOURCE, scope: 'mcp:read' },
          remoteAddress: '203.0.113.80',
          url: '/api/auth/device/code',
        })
      );
    }
    expect(responses[0]?.statusCode).toBe(400);
    expect(responses[10]?.statusCode).toBe(429);
  });
});
