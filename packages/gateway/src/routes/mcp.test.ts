import rateLimit from '@fastify/rate-limit';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpTokenVerifier, type McpTokenRejection } from '../lib/mcpTokenVerifier.js';
import {
  fakeVerifierDeps,
  makeSigningKey,
  mintToken,
  TEST_ISSUER,
  TEST_RESOURCE,
  type TestKey,
} from '../test/mcpTokens.js';
import { mcpRoutes } from './mcp.js';

const PRM_PATH = '/.well-known/oauth-protected-resource/api/v1/mcp';
const PRM_URL = `http://localhost:8080${PRM_PATH}`;
const ORIGIN_OK = 'http://localhost:3000';

const initializeLegacy = {
  id: 1,
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    capabilities: {},
    clientInfo: { name: 'legacy-client', version: '1.0.0' },
    protocolVersion: '2025-06-18',
  },
};
const listToolsLegacy = { id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} };
const modernMeta = {
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '1.0.0' },
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
};
const modern = (method: string, params: Record<string, unknown> = {}, id = 7) => ({
  id,
  jsonrpc: '2.0',
  method,
  params: { ...params, _meta: modernMeta },
});

describe('MCP endpoint', () => {
  let app: FastifyInstance;
  let key: TestKey;
  const settings = { enabled: true, writeToolsEnabled: false };
  let settingsFail = false;
  let rejections: McpTokenRejection[] = [];
  const deps = (k: TestKey) => fakeVerifierDeps([k]);

  beforeAll(async () => {
    key = await makeSigningKey('route-key');
    const verifierDeps = deps(key);
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // The gateway's own hooks and handler, which the MCP routes must live under.
    app.addHook('onRoute', (routeOptions) => {
      if (!routeOptions.schema?.response) {
        routeOptions.schema = { ...routeOptions.schema, response: { 200: z.any() } };
      }
    });
    app.setErrorHandler(async (error: FastifyError, _request, reply) => {
      const statusCode = error.statusCode ?? 500;
      return reply.status(statusCode).send({
        error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message },
      });
    });
    await app.register(rateLimit, { max: 10_000, timeWindow: '1 minute' });
    await app.register(mcpRoutes, {
      allowedOriginHostnames: ['localhost'],
      getSettings: async () => {
        if (settingsFail) {
          throw new Error('registry unavailable');
        }
        return { ...settings };
      },
      issuer: TEST_ISSUER,
      resource: TEST_RESOURCE,
      serverVersion: '1.0.0',
      verifier: createMcpTokenVerifier({
        ...verifierDeps,
        getWriteToolsEnabled: async () => settings.writeToolsEnabled,
        onReject: (reason) => rejections.push(reason),
      }),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    settings.enabled = true;
    settings.writeToolsEnabled = false;
    settingsFail = false;
    rejections = [];
  });

  const bearer = async (o: Parameters<typeof mintToken>[0] | undefined = undefined) =>
    `Bearer ${await mintToken(o ?? { key })}`;

  async function post(body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: await bearer(),
        'content-type': 'application/json',
        ...headers,
      },
      method: 'POST',
      payload: JSON.stringify(body),
      url: '/api/v1/mcp',
    });
  }

  /** The JSON-RPC message in a response, whichever way the era frames it. */
  function rpc(res: { body: string; headers: Record<string, unknown> }) {
    const type = String(res.headers['content-type']);
    if (type.startsWith('text/event-stream')) {
      const data = res.body.split('\n').find((line) => line.startsWith('data:'));
      return JSON.parse(String(data).slice(5));
    }
    return JSON.parse(res.body);
  }

  describe('the challenge', () => {
    it('answers a request with no token 401, naming the metadata and the default scope', async () => {
      const res = await app.inject({ method: 'POST', payload: {}, url: '/api/v1/mcp' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain(`resource_metadata="${PRM_URL}"`);
      expect(res.headers['www-authenticate']).toContain('scope="mcp:read"');
      expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    });

    it.each([
      [
        'a token for another audience',
        { claims: { aud: 'http://localhost:8080/other' } },
        'wrong-audience',
      ],
      ['a token with no audience', { omit: ['aud'] }, 'wrong-audience'],
      ['an unrecognised type', { typ: 'JWT' }, 'wrong-type'],
      ['no type', { typ: null }, 'wrong-type'],
    ])('answers %s with 401 and the same challenge', async (_name, extra, reason) => {
      const res = await app.inject({
        headers: { authorization: await bearer({ key, ...extra } as never) },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain(`resource_metadata="${PRM_URL}"`);
      expect(res.headers['www-authenticate']).toContain('scope="mcp:read"');
      expect(rejections).toEqual([reason]);
    });

    it('answers an expired token 401', async () => {
      const past = Math.floor(Date.now() / 1000) - 7200;
      const res = await app.inject({
        headers: { authorization: await bearer({ exp: past + 600, iat: past, key }) },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(401);
      expect(rejections).toEqual(['expired']);
    });

    it.each([
      ['an opaque token', 'Bearer o9p8a7q6u5e4t3o2k1e0n'],
      ['a personal access token', 'Bearer ats_0123456789abcdef0123456789abcdef'],
      ['basic credentials', 'Basic dXNlcjpwYXNz'],
    ])('answers %s 401', async (_name, authorization) => {
      const res = await app.inject({
        headers: { authorization },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    });

    it('answers a JWT of the REST API (another key and audience) 401', async () => {
      const token = await new SignJWT({ role: 'ADMIN' })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience('auto-swe:api')
        .setSubject('u')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
      const res = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(401);
    });

    it('answers a token of the right shape signed by another key 401', async () => {
      const stranger = await makeSigningKey('route-key');
      const res = await app.inject({
        headers: { authorization: await bearer({ key: stranger }) },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(401);
      expect(rejections).toEqual(['bad-signature']);
    });

    it('answers a valid token that carries no MCP scope 403 insufficient_scope', async () => {
      const res = await app.inject({
        headers: { authorization: await bearer({ claims: { scope: 'offline_access' }, key }) },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
      expect(res.headers['www-authenticate']).toContain('scope="mcp:read"');
      expect(res.headers['www-authenticate']).toContain(`resource_metadata="${PRM_URL}"`);
    });

    it('answers a server fault while verifying 500, not 401', async () => {
      const broken = Fastify();
      await broken.register(mcpRoutes, {
        allowedOriginHostnames: [],
        getSettings: async () => ({ enabled: true, writeToolsEnabled: false }),
        issuer: TEST_ISSUER,
        resource: TEST_RESOURCE,
        serverVersion: '1.0.0',
        verifier: {
          verifyAccessToken: async () => {
            throw new Error('database down');
          },
        },
      });
      const res = await broken.inject({
        headers: { authorization: 'Bearer anything' },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers['www-authenticate']).toBeUndefined();
      await broken.close();
    });
  });

  describe('the transport', () => {
    it('serves a legacy-era client: initialize, then an empty tools/list, as one SSE frame', async () => {
      const init = await post(initializeLegacy);
      expect(init.statusCode).toBe(200);
      expect(String(init.headers['content-type'])).toMatch(/^text\/event-stream/);
      expect(rpc(init).result).toMatchObject({
        capabilities: { tools: {} },
        serverInfo: { name: 'auto-swe', version: '1.0.0' },
      });
      expect(rpc(init).result.capabilities.resources).toBeUndefined();
      expect(rpc(init).result.capabilities.prompts).toBeUndefined();

      const list = await post(listToolsLegacy, { 'mcp-protocol-version': '2025-06-18' });
      expect(list.statusCode).toBe(200);
      expect(rpc(list).result).toEqual({ tools: [] });
    });

    it('serves a modern-envelope client a plain JSON body', async () => {
      const res = await post(modern('tools/list'), {
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '2026-07-28',
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toMatch(/^application\/json/);
      expect(rpc(res).result.tools).toEqual([]);
    });

    it('answers GET and DELETE 405 once authenticated, and 401 before', async () => {
      for (const method of ['GET', 'DELETE'] as const) {
        const authed = await app.inject({
          headers: { accept: 'text/event-stream', authorization: await bearer() },
          method,
          url: '/api/v1/mcp',
        });
        expect(authed.statusCode, method).toBe(405);
        const anonymous = await app.inject({ method, url: '/api/v1/mcp' });
        expect(anonymous.statusCode, method).toBe(401);
      }
    });

    it('refuses subscriptions/listen', async () => {
      const res = await post(
        modern('subscriptions/listen', { notifications: { toolsListChanged: true } }),
        { 'mcp-method': 'subscriptions/listen', 'mcp-protocol-version': '2026-07-28' }
      );
      expect(String(res.headers['content-type'])).not.toMatch(/^text\/event-stream/);
      expect(rpc(res).error).toMatchObject({ code: -32603 });
      expect(rpc(res).result).toBeUndefined();
    });

    it('answers a body that is not JSON 415 and a malformed one 400', async () => {
      const text = await app.inject({
        headers: { authorization: await bearer(), 'content-type': 'text/plain' },
        method: 'POST',
        payload: 'hello',
        url: '/api/v1/mcp',
      });
      expect(text.statusCode).toBe(415);
      const form = await app.inject({
        headers: {
          authorization: await bearer(),
          'content-type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
        payload: 'a=b',
        url: '/api/v1/mcp',
      });
      expect(form.statusCode).toBe(415);
      const broken = await app.inject({
        headers: { authorization: await bearer(), 'content-type': 'application/json' },
        method: 'POST',
        payload: '{not json',
        url: '/api/v1/mcp',
      });
      expect(broken.statusCode).toBe(400);
    });

    it('answers a notification 202 with no body', async () => {
      const res = await post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { 'mcp-protocol-version': '2025-06-18' }
      );
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe('');
    });
  });

  describe('Origin', () => {
    it('refuses a browser origin that is not ours, before it learns anything about the token', async () => {
      const res = await app.inject({
        headers: { origin: 'https://evil.example' },
        method: 'POST',
        payload: {},
        url: '/api/v1/mcp',
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['www-authenticate']).toBeUndefined();
    });

    it.each(['null', 'not a url'])('refuses the origin %j', async (origin) => {
      const res = await post(initializeLegacy, { origin });
      expect(res.statusCode).toBe(403);
    });

    it('lets an allowed origin and a request with none through', async () => {
      expect((await post(initializeLegacy, { origin: ORIGIN_OK })).statusCode).toBe(200);
      expect((await post(initializeLegacy)).statusCode).toBe(200);
    });
  });

  describe('protected resource metadata', () => {
    it('names the resource, the issuer and only the read scope while writes are off', async () => {
      const res = await app.inject({ method: 'GET', url: PRM_PATH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        authorization_servers: [TEST_ISSUER],
        resource: TEST_RESOURCE,
        resource_name: 'auto-swe MCP',
        scopes_supported: ['mcp:read'],
      });
    });

    it('advertises mcp:write only while writes are enabled, and never offline_access', async () => {
      settings.writeToolsEnabled = true;
      const res = await app.inject({ method: 'GET', url: PRM_PATH });
      expect(res.json().scopes_supported).toEqual(['mcp:read', 'mcp:write']);
    });

    it('is also served at the root, and needs no credential', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
      expect(res.statusCode).toBe(200);
      expect(res.json().resource).toBe(TEST_RESOURCE);
    });

    it('points the challenge at a URL that serves it', async () => {
      const challenge = (await app.inject({ method: 'POST', payload: {}, url: '/api/v1/mcp' }))
        .headers['www-authenticate'];
      const url = new URL(/resource_metadata="([^"]+)"/.exec(String(challenge))?.[1] ?? '');
      expect((await app.inject({ method: 'GET', url: url.pathname })).statusCode).toBe(200);
    });
  });

  describe('mcp.enabled, read on every request', () => {
    it('answers 404 everywhere while off and works again when turned back on, without a restart', async () => {
      const probe = async () => ({
        mcp: (await post(initializeLegacy)).statusCode,
        mcpAnonymous: (await app.inject({ method: 'POST', payload: {}, url: '/api/v1/mcp' }))
          .statusCode,
        prm: (await app.inject({ method: 'GET', url: PRM_PATH })).statusCode,
        prmRoot: (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' }))
          .statusCode,
      });
      expect(await probe()).toEqual({ mcp: 200, mcpAnonymous: 401, prm: 200, prmRoot: 200 });
      settings.enabled = false;
      expect(await probe()).toEqual({ mcp: 404, mcpAnonymous: 404, prm: 404, prmRoot: 404 });
      settings.enabled = true;
      expect(await probe()).toEqual({ mcp: 200, mcpAnonymous: 401, prm: 200, prmRoot: 200 });
    });

    it('fails closed with 503 when the setting cannot be read', async () => {
      settingsFail = true;
      expect((await post(initializeLegacy)).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: PRM_PATH })).statusCode).toBe(503);
    });
  });
});
