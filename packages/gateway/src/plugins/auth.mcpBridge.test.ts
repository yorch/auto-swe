import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_BRIDGE_HEADER, mcpBridgePlugin } from '../lib/mcp/bridge.js';
import { createMcpTokenVerifier, type McpGrant } from '../lib/mcpTokenVerifier.js';
import {
  fakeVerifierDeps,
  makeSigningKey,
  mintToken,
  TEST_RESOURCE,
  TEST_USER,
  type TestKey,
} from '../test/mcpTokens.js';
import authPlugin, { requireAuth } from './auth.js';

// The gate is read from the settings registry, which needs a database this test does not have.
vi.mock('@auto-swe/shared/lib/repoAccessGate', () => ({
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

/**
 * The bridge's forgery tests: the real `requireAuth` and the real `authPlugin`, the real MCP
 * verifier over a test key set, probe routes that declare (or do not declare) `mcpScope`, and no
 * Authorization overwrite (`makeAuthedApp`'s default would hide every one of these cases).
 *
 * The secret exists only inside the bridge. The tests learn it the way a leak would: by watching
 * a real bridged call arrive, then replaying it by hand with the one thing changed.
 */
describe('requireAuth and the MCP bridge', () => {
  let key: TestKey;
  const state: NonNullable<Parameters<typeof fakeVerifierDeps>[1]> = {};
  let defaultGrant: McpGrant | null | undefined;

  async function build() {
    const deps = fakeVerifierDeps([key], state);
    defaultGrant = state.grant;
    const app = Fastify();
    app.decorate('prisma', {
      personalAccessToken: { findUnique: async () => null, update: async () => ({}) },
      user: {
        findUnique: async () => ({ isActive: true, role: 'ENGINEER', slackId: null }),
      },
    } as never);
    await app.register(authPlugin);
    await app.register(mcpBridgePlugin, { verifier: createMcpTokenVerifier(deps) });

    // What the secret was, as a leak would reveal it: the header of a request the bridge made.
    const leak: { secret?: string } = {};
    app.addHook('onRequest', async (request) => {
      const header = request.headers[MCP_BRIDGE_HEADER];
      if (typeof header === 'string' && app.mcpBridge?.accepts(header)) {
        leak.secret = header;
      }
    });

    const probe = (request: { user?: { sub: string; role: string }; mcpBridge?: unknown }) => ({
      bridge: request.mcpBridge,
      role: request.user?.role,
      sub: request.user?.sub,
    });
    app.get(
      '/probe/read',
      { config: { mcpScope: 'read' }, onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
      async (request) => probe(request)
    );
    app.post(
      '/probe/write',
      { config: { mcpScope: 'write' }, onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
      async (request) => probe(request)
    );
    app.get(
      '/probe/lead-only',
      { config: { mcpScope: 'read' }, onRequest: requireAuth({ requiredRole: 'LEAD' }) },
      async (request) => probe(request)
    );
    // A route that never opted in: the REST surface as it is today.
    app.get('/probe/undeclared', { onRequest: requireAuth() }, async (request) => probe(request));
    app.post('/api/v1/work-requests', { onRequest: requireAuth() }, async (request) =>
      probe(request)
    );
    await app.ready();
    return { app, leak };
  }

  let app: FastifyInstance;
  let leak: { secret?: string };
  let readToken: string;
  let writeToken: string;

  beforeAll(async () => {
    key = await makeSigningKey('bridge-key');
    readToken = await mintToken({ key });
    writeToken = await mintToken({ claims: { scope: 'mcp:read mcp:write' }, key });
    ({ app, leak } = await build());
    // Observe one genuine bridged call, so the secret can be replayed.
    const res = await app.mcpBridge?.get(
      app,
      { clientIp: '203.0.113.9', scopes: ['mcp:read'], token: readToken, userId: TEST_USER },
      '/probe/read'
    );
    expect(res?.status).toBe(200);
    expect(leak.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  beforeEach(() => {
    state.user = { isActive: true, role: 'ENGINEER' };
    state.writeToolsEnabled = true;
    state.grant = defaultGrant;
  });

  afterAll(async () => {
    await app.close();
  });

  const secret = () => leak.secret as string;
  const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string | string[]>) =>
    app.inject({ headers, method, url });
  const bridged = (
    url: string,
    token: string,
    bridge: string | string[] | null = secret(),
    method: 'GET' | 'POST' = 'GET'
  ) =>
    call(method, url, {
      authorization: `Bearer ${token}`,
      ...(bridge === null ? {} : { [MCP_BRIDGE_HEADER]: bridge }),
    });

  it('serves a bridged call as the token user, with the current role and the grant', async () => {
    const res = await app.mcpBridge?.get(
      app,
      { clientIp: '203.0.113.9', scopes: ['mcp:read'], token: readToken, userId: TEST_USER },
      '/probe/read'
    );
    expect(res?.body).toEqual({
      bridge: { clientId: 'client-abc', consentId: 'consent-1', scopes: ['mcp:read'] },
      role: 'ENGINEER',
      sub: TEST_USER,
    });
  });

  // 1
  it('refuses a valid MCP token sent straight to a REST route', async () => {
    const res = await bridged('/api/v1/work-requests', readToken, null, 'POST');
    expect(res.statusCode).toBe(401);
    const read = await bridged('/probe/read', readToken, null);
    expect(read.statusCode).toBe(401);
  });

  // 2
  it.each([
    ['empty', () => ''],
    ['random 64 hex', () => 'a'.repeat(64)],
    ['truncated', () => secret().slice(0, 63)],
    ['over-long', () => `${secret()}0`],
    ['the secret twice, comma-joined', () => `${secret()}, ${secret()}`],
    ['the secret duplicated as an array', () => [secret(), secret()]],
    ['the secret in another case', () => secret().toUpperCase()],
  ])('refuses a bridge header that is %s with 403', async (_name, value) => {
    const res = await bridged('/probe/read', readToken, value());
    expect(res.statusCode).toBe(403);
  });

  it('never falls through to another credential when the bridge header is wrong', async () => {
    // A valid API JWT, a valid PAT shape and the right route: the header's presence decides.
    const apiJwt = app.auth.signAccessToken({ role: 'ADMIN', sub: TEST_USER });
    for (const bearer of [apiJwt, 'ats_0123456789abcdef0123456789abcdef', readToken]) {
      const res = await bridged('/probe/read', bearer, 'wrong');
      expect(res.statusCode).toBe(403);
    }
  });

  // 3
  it('refuses the right secret on a route that declares no mcpScope', async () => {
    expect((await bridged('/probe/undeclared', readToken)).statusCode).toBe(403);
    expect((await bridged('/api/v1/work-requests', writeToken, secret(), 'POST')).statusCode).toBe(
      403
    );
  });

  // 5
  it('refuses the right secret with a credential that is not an MCP access token', async () => {
    const apiJwt = app.auth.signAccessToken({ role: 'ADMIN', sub: TEST_USER });
    const wrongType = await mintToken({ key, typ: 'JWT' });
    const wrongAudience = await mintToken({ claims: { aud: 'http://elsewhere/api' }, key });
    for (const token of [
      'ats_0123456789abcdef0123456789abcdef',
      apiJwt,
      wrongType,
      wrongAudience,
      'not-a-token',
    ]) {
      expect((await bridged('/probe/read', token)).statusCode, token).toBe(401);
    }
    // No bearer at all, and a session cookie in its place.
    const cookie = await call('GET', '/probe/read', {
      [MCP_BRIDGE_HEADER]: secret(),
      cookie: 'better-auth.session_token=anything.signature',
    });
    expect(cookie.statusCode).toBe(401);
    // A bearer that is not exactly `Bearer <token>`.
    const spaced = await call('GET', '/probe/read', {
      authorization: `Bearer ${readToken} extra`,
      [MCP_BRIDGE_HEADER]: secret(),
    });
    expect(spaced.statusCode).toBe(401);
  });

  // 7
  it('draws a different secret for every app instance', async () => {
    const other = await build();
    await other.app.mcpBridge?.get(
      other.app,
      { clientIp: '203.0.113.9', scopes: ['mcp:read'], token: readToken, userId: TEST_USER },
      '/probe/read'
    );
    expect(other.leak.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(other.leak.secret).not.toBe(secret());
    // And one instance's secret opens nothing on the other.
    const res = await other.app.inject({
      headers: { authorization: `Bearer ${readToken}`, [MCP_BRIDGE_HEADER]: secret() },
      method: 'GET',
      url: '/probe/read',
    });
    expect(res.statusCode).toBe(403);
    await other.app.close();
  });

  // 8
  describe('scopes', () => {
    it('lets a read token read and refuses it on a write route', async () => {
      expect((await bridged('/probe/read', readToken)).statusCode).toBe(200);
      const res = await bridged('/probe/write', readToken, secret(), 'POST');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('lets a write token write, and read, only while writes are enabled', async () => {
      expect((await bridged('/probe/write', writeToken, secret(), 'POST')).statusCode).toBe(200);
      expect((await bridged('/probe/read', writeToken)).statusCode).toBe(200);
      state.writeToolsEnabled = false;
      expect((await bridged('/probe/write', writeToken, secret(), 'POST')).statusCode).toBe(403);
      // Read survives: the token's read scope and the consent both stand.
      expect((await bridged('/probe/read', writeToken)).statusCode).toBe(200);
    });

    it('narrows the token to what the user consented to', async () => {
      state.grant = {
        clientActive: true,
        consentId: 'consent-1',
        consentScopes: ['mcp:read'],
        consentUpdatedAt: new Date(Date.now() - 60_000),
      };
      expect((await bridged('/probe/write', writeToken, secret(), 'POST')).statusCode).toBe(403);
    });
  });

  it('keeps the route role check: a bridged ENGINEER is not a LEAD', async () => {
    expect((await bridged('/probe/lead-only', readToken)).statusCode).toBe(403);
  });

  it('uses the user as they are now: a deactivated user is refused, a demoted one is demoted', async () => {
    state.user = { isActive: false, role: 'ENGINEER' };
    expect((await bridged('/probe/read', readToken)).statusCode).toBe(401);
    state.user = { isActive: true, role: 'ADMIN' };
    const res = await bridged('/probe/read', readToken);
    expect(res.json().role).toBe('ADMIN');
  });

  it('refuses a token whose consent was revoked, with the secret in hand', async () => {
    state.grant = null;
    expect((await bridged('/probe/read', readToken)).statusCode).toBe(401);
  });

  it('answers a verifier outage as a server error, not a refusal', async () => {
    const deps = fakeVerifierDeps([key]);
    deps.loadGrant = async () => {
      throw new Error('database down');
    };
    const broken = Fastify();
    broken.decorate('prisma', {} as never);
    await broken.register(authPlugin);
    await broken.register(mcpBridgePlugin, { verifier: createMcpTokenVerifier(deps) });
    broken.get(
      '/probe/read',
      { config: { mcpScope: 'read' }, onRequest: requireAuth() },
      async () => ({})
    );
    const res = await broken.mcpBridge?.get(
      broken,
      { clientIp: '203.0.113.9', scopes: ['mcp:read'], token: readToken, userId: TEST_USER },
      '/probe/read'
    );
    expect(res?.status).toBe(500);
    await broken.close();
  });

  it('is inert in an app with no bridge: the header alone opens nothing', async () => {
    const bare = Fastify();
    bare.decorate('prisma', {} as never);
    await bare.register(authPlugin);
    bare.get(
      '/probe/read',
      { config: { mcpScope: 'read' }, onRequest: requireAuth() },
      async () => ({})
    );
    const res = await bare.inject({
      headers: { authorization: `Bearer ${readToken}`, [MCP_BRIDGE_HEADER]: secret() },
      method: 'GET',
      url: '/probe/read',
    });
    expect(res.statusCode).toBe(403);
    await bare.close();
  });

  it('keeps TEST_RESOURCE honest: the audience these tokens carry is the one the verifier wants', async () => {
    const wrongAudience = await mintToken({ claims: { aud: `${TEST_RESOURCE}/x` }, key });
    expect((await bridged('/probe/read', wrongAudience)).statusCode).toBe(401);
  });
});
