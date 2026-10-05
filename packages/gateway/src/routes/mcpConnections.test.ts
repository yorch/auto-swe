import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConnectionRoutes } from './mcpConnections.js';

vi.mock('../lib/mcpProbe.js', () => ({
  probeMcpServer: vi.fn(async () => ({ durationMs: 12, ok: true, toolCount: 3, toolNames: ['a'] })),
}));

import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import { openMcpHeaders, sealMcpHeaders } from '@auto-swe/shared/lib/mcpHeaders';
import { probeMcpServer } from '../lib/mcpProbe.js';

function newMockPrisma() {
  return {
    agent: { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    team: { findUnique: vi.fn() },
  };
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };
const TEAM = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  _resetKeyCacheForTests();
});

describe('mcpConnectionRoutes', () => {
  it('lists active mcp connections', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([{ id: ID, name: 'docs', type: 'mcp' }]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toHaveLength(1);
    expect(mockPrisma.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, type: 'mcp' } })
    );
    await app.close();
  });

  it('lists the agents whose current version binds each connection', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findMany.mockResolvedValue([{ id: ID, name: 'docs', type: 'mcp' }]);
    const lineage = {
      channelId: null,
      key: 'reviewer',
      orgId: null,
      scope: 'GLOBAL',
      teamId: null,
      workflowTemplateId: null,
    };
    mockPrisma.agent.findMany.mockResolvedValue([
      { ...lineage, mcpConnectionId: ID, name: 'Reviewer', version: 2 },
      // An older version that still binds it: history, not use.
      { ...lineage, key: 'planner', mcpConnectionId: ID, name: 'Planner', version: 1 },
    ]);
    mockPrisma.agent.groupBy.mockResolvedValue([
      { ...lineage, _max: { version: 2 } },
      { ...lineage, _max: { version: 3 }, key: 'planner' },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(JSON.parse(res.payload).data[0].usedBy).toEqual([
      { key: 'reviewer', name: 'Reviewer', scope: 'GLOBAL' },
    ]);
  });

  describe('POST /mcp-connections/:id/test', () => {
    const url = `/api/v1/platform/mcp-connections/${ID}/test`;

    it('probes the saved URL within the connection timeout', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { listTimeoutMs: 4000, url: 'https://mcp.example.com/mcp' },
        id: ID,
      });
      const res = await app.inject({ headers: AUTH, method: 'POST', url });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toMatchObject({ ok: true, toolCount: 3 });
      expect(probeMcpServer).toHaveBeenCalledWith('https://mcp.example.com/mcp', 4000, undefined, {
        bearerToken: undefined,
        headers: [],
      });
    });

    it('does not probe an address the SSRF guard refuses', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { url: 'http://169.254.169.254/' },
        id: ID,
      });
      const res = await app.inject({ headers: AUTH, method: 'POST', url });
      expect(JSON.parse(res.payload).data.ok).toBe(false);
      expect(probeMcpServer).not.toHaveBeenCalled();
    });

    it('404s an unknown connection and rejects a non-admin', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(null);
      expect((await app.inject({ headers: AUTH, method: 'POST', url })).statusCode).toBe(404);
      const other = await buildApp('ENGINEER');
      expect((await other.app.inject({ headers: AUTH, method: 'POST', url })).statusCode).toBe(403);
    });
  });

  it('rejects a non-admin', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('creates an mcp connection with the url in config', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
    mockPrisma.connection.create.mockResolvedValue({ id: ID, name: 'docs', type: 'mcp' });
    const res = await app.inject({
      body: { name: 'docs', teamId: TEAM, url: 'https://mcp.example.com/mcp' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(201);
    expect(mockPrisma.connection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          config: { url: 'https://mcp.example.com/mcp' },
          name: 'docs',
          teamId: TEAM,
          type: 'mcp',
        },
      })
    );
    await app.close();
  });

  it('sanitizes credentials, query parameters, and fragments from the audit payload', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
    mockPrisma.connection.create.mockResolvedValue({ id: ID, name: 'docs', type: 'mcp' });
    const res = await app.inject({
      body: {
        name: 'docs',
        teamId: TEAM,
        url: 'https://user:password@mcp.example.com/mcp?token=secret#private',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });

    expect(res.statusCode).toBe(201);
    expect(mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterJson: expect.objectContaining({ url: 'https://mcp.example.com/mcp' }),
      }),
    });
    const audit = mockPrisma.configAuditLog.create.mock.calls[0]?.[0];
    expect(JSON.stringify(audit)).not.toContain('password');
    expect(JSON.stringify(audit)).not.toContain('secret');
    await app.close();
  });

  it('creates an mcp connection with optional list/call timeouts persisted in config', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
    mockPrisma.connection.create.mockResolvedValue({ id: ID, name: 'docs', type: 'mcp' });
    const res = await app.inject({
      body: {
        callTimeoutMs: 90_000,
        listTimeoutMs: 30_000,
        name: 'docs',
        teamId: TEAM,
        url: 'https://mcp.example.com/mcp',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(201);
    expect(mockPrisma.connection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          config: {
            callTimeoutMs: 90_000,
            listTimeoutMs: 30_000,
            url: 'https://mcp.example.com/mcp',
          },
          name: 'docs',
          teamId: TEAM,
          type: 'mcp',
        },
      })
    );
    await app.close();
  });

  it('400s on a non-positive timeout override', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      body: { listTimeoutMs: 0, name: 'docs', teamId: TEAM, url: 'https://mcp.example.com/mcp' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('404s when the team is missing', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      body: { name: 'docs', teamId: TEAM, url: 'https://mcp.example.com/mcp' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400s on a non-http(s) url', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      body: { name: 'docs', teamId: TEAM, url: 'ftp://mcp.example.com' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/mcp-connections',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('soft-deletes an mcp connection', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findFirst.mockResolvedValue({ id: ID, name: 'docs', type: 'mcp' });
    mockPrisma.connection.update.mockResolvedValue({ id: ID });
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/platform/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } })
    );
    await app.close();
  });

  it('404s deleting an unknown mcp connection', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: `/api/v1/platform/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('updates name/url + timeouts, rebuilding config from the body', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findFirst.mockResolvedValue({
      config: { callTimeoutMs: 60_000, url: 'https://old.example.com/mcp' },
      id: ID,
      name: 'old',
      type: 'mcp',
    });
    mockPrisma.connection.update.mockResolvedValue({ id: ID, name: 'renamed', type: 'mcp' });
    const res = await app.inject({
      body: {
        listTimeoutMs: 20_000,
        name: 'renamed',
        url: 'https://new.example.com/mcp',
      },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/platform/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(200);
    // config is rebuilt from the body: the old callTimeoutMs is dropped (cleared)
    // and the new listTimeoutMs is set.
    expect(mockPrisma.connection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          config: { listTimeoutMs: 20_000, url: 'https://new.example.com/mcp' },
          name: 'renamed',
        },
        where: { id: ID },
      })
    );
    await app.close();
  });

  it('404s updating an unknown mcp connection', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findFirst.mockResolvedValue(null);
    const res = await app.inject({
      body: { name: 'x', url: 'https://mcp.example.com/mcp' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/platform/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(404);
    expect(mockPrisma.connection.update).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s updating with a non-http(s) url', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.connection.findFirst.mockResolvedValue({ id: ID, name: 'old', type: 'mcp' });
    const res = await app.inject({
      body: { name: 'x', url: 'ftp://mcp.example.com' },
      headers: AUTH,
      method: 'PATCH',
      url: `/api/v1/platform/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  describe('bearer token', () => {
    const TOKEN = 'sk-mcp-secret-token-1234';
    const BASE = '/api/v1/platform/mcp-connections';

    /** A stored row as Prisma returns it: envelope columns present. */
    function storedRow(over: Record<string, unknown> = {}) {
      const enc = encryptSecret(TOKEN);
      return {
        apiKeyAuthTag: enc.authTag,
        apiKeyCiphertext: enc.ciphertext,
        apiKeyNonce: enc.nonce,
        apiKeyVersion: enc.keyVersion,
        config: { url: 'https://mcp.example.com/mcp' },
        id: ID,
        name: 'docs',
        type: 'mcp',
        ...over,
      };
    }

    it('stores a created token encrypted, and returns only hasToken', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
      mockPrisma.connection.create.mockImplementation(async ({ data }) => ({
        id: ID,
        name: 'docs',
        type: 'mcp',
        ...data,
      }));
      const res = await app.inject({
        body: {
          bearerToken: TOKEN,
          name: 'docs',
          teamId: TEAM,
          url: 'https://mcp.example.com/mcp',
        },
        headers: AUTH,
        method: 'POST',
        url: BASE,
      });
      expect(res.statusCode).toBe(201);
      const data = mockPrisma.connection.create.mock.calls[0]?.[0].data;
      // Never in config, never plaintext in a column, and the envelope round-trips.
      expect(JSON.stringify(data.config)).not.toContain(TOKEN);
      expect(Buffer.from(data.apiKeyCiphertext).toString('utf8')).not.toContain(TOKEN);
      expect(
        decryptSecret({
          authTag: data.apiKeyAuthTag,
          ciphertext: data.apiKeyCiphertext,
          keyVersion: data.apiKeyVersion,
          nonce: data.apiKeyNonce,
        })
      ).toBe(TOKEN);
      expect(res.payload).not.toContain(TOKEN);
      expect(res.payload).not.toContain('apiKey');
      expect(JSON.parse(res.payload).data.hasToken).toBe(true);
      // The audit trail knows a token exists, not what it is.
      const audit = JSON.stringify(mockPrisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain(TOKEN);
      expect(audit).toContain('"hasToken":true');
      await app.close();
    });

    it('rejects a token that is not a clean header value', async () => {
      const { app } = await buildApp();
      for (const bad of ['has space', 'line\nbreak', '']) {
        const res = await app.inject({
          body: {
            bearerToken: bad,
            name: 'docs',
            teamId: TEAM,
            url: 'https://mcp.example.com/mcp',
          },
          headers: AUTH,
          method: 'POST',
          url: BASE,
        });
        expect(res.statusCode).toBe(400);
        expect(res.payload).not.toContain(bad || 'zzzz-none');
      }
      await app.close();
    });

    it('never returns the token or its envelope when listing', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findMany.mockResolvedValue([storedRow(), { id: 'x', name: 'n' }]);
      const res = await app.inject({ headers: AUTH, method: 'GET', url: BASE });
      expect(res.payload).not.toContain(TOKEN);
      expect(res.payload).not.toContain('apiKey');
      expect(JSON.parse(res.payload).data.map((r: { hasToken: boolean }) => r.hasToken)).toEqual([
        true,
        false,
      ]);
      await app.close();
    });

    it('keeps the stored token when an edit omits it', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      mockPrisma.connection.update.mockResolvedValue(storedRow({ name: 'renamed' }));
      const res = await app.inject({
        body: { name: 'renamed', url: 'https://mcp.example.com/mcp' },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
      const data = mockPrisma.connection.update.mock.calls[0]?.[0].data;
      expect(Object.keys(data)).not.toContain('apiKeyCiphertext');
      expect(JSON.parse(res.payload).data.hasToken).toBe(true);
      await app.close();
    });

    it('replaces the token when an edit supplies one', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      mockPrisma.connection.update.mockResolvedValue(storedRow());
      await app.inject({
        body: {
          bearerToken: 'sk-new-token-5678',
          name: 'docs',
          url: 'https://other.example.com/mcp',
        },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      const data = mockPrisma.connection.update.mock.calls[0]?.[0].data;
      expect(
        decryptSecret({
          authTag: data.apiKeyAuthTag,
          ciphertext: data.apiKeyCiphertext,
          keyVersion: data.apiKeyVersion,
          nonce: data.apiKeyNonce,
        })
      ).toBe('sk-new-token-5678');
      const audit = JSON.stringify(mockPrisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain('sk-new-token-5678');
      expect(audit).not.toContain(TOKEN);
      await app.close();
    });

    it('clears the stored token on request', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      mockPrisma.connection.update.mockResolvedValue(storedRow({ apiKeyCiphertext: null }));
      const res = await app.inject({
        body: { clearBearerToken: true, name: 'docs', url: 'https://mcp.example.com/mcp' },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
      expect(mockPrisma.connection.update.mock.calls[0]?.[0].data).toMatchObject({
        apiKeyAuthTag: null,
        apiKeyCiphertext: null,
        apiKeyNonce: null,
      });
      expect(JSON.parse(res.payload).data.hasToken).toBe(false);
      await app.close();
    });

    it('refuses a new token and a clear in the same request', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        body: {
          bearerToken: 'sk-abc',
          clearBearerToken: true,
          name: 'docs',
          url: 'https://mcp.example.com/mcp',
        },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it('refuses to point a stored token at a different origin', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      const res = await app.inject({
        body: { name: 'docs', url: 'https://attacker.example.net/mcp' },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error.code).toBe('TOKEN_ORIGIN_CHANGE');
      expect(mockPrisma.connection.update).not.toHaveBeenCalled();
      await app.close();
    });

    it('allows a path change on the same origin to keep the token', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      mockPrisma.connection.update.mockResolvedValue(storedRow());
      const res = await app.inject({
        body: { name: 'docs', url: 'https://mcp.example.com/v2/mcp' },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it('hands the decrypted token to the probe, and nothing else carries it', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(storedRow());
      const res = await app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${ID}/test` });
      expect(probeMcpServer).toHaveBeenCalledWith(
        'https://mcp.example.com/mcp',
        15_000,
        undefined,
        {
          bearerToken: TOKEN,
          headers: [],
        }
      );
      expect(res.payload).not.toContain(TOKEN);
      await app.close();
    });

    it('reports an unreadable stored token without probing', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(
        storedRow({ apiKeyCiphertext: new Uint8Array(8) })
      );
      const res = await app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${ID}/test` });
      expect(JSON.parse(res.payload).data.ok).toBe(false);
      expect(probeMcpServer).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('allowPrivateNetwork', () => {
    const BASE = '/api/v1/platform/mcp-connections';
    const create = async (url: string, allowPrivateNetwork?: boolean) => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
      mockPrisma.connection.create.mockImplementation(async ({ data }) => ({
        id: ID,
        type: 'mcp',
        ...data,
      }));
      const res = await app.inject({
        body: { allowPrivateNetwork, name: 'internal', teamId: TEAM, url },
        headers: AUTH,
        method: 'POST',
        url: BASE,
      });
      return { app, mockPrisma, res };
    };

    it('refuses a private address by default', async () => {
      const { res } = await create('http://10.0.0.5:8080/mcp');
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error.code).toBe('UNSAFE_URL');
    });

    it('accepts RFC 1918 and ULA addresses with the opt-in and records it in config and audit', async () => {
      for (const target of ['http://10.0.0.5:8080/mcp', 'http://[fd12:3456::1]/mcp']) {
        const { mockPrisma, res } = await create(target, true);
        expect(res.statusCode, target).toBe(201);
        expect(mockPrisma.connection.create.mock.calls[0]?.[0].data.config).toMatchObject({
          allowPrivateNetwork: true,
        });
        expect(JSON.stringify(mockPrisma.configAuditLog.create.mock.calls)).toContain(
          '"allowPrivateNetwork":true'
        );
      }
    });

    it('never accepts loopback, link-local, unspecified or metadata addresses, even with the opt-in', async () => {
      for (const target of [
        'http://127.0.0.1:8080/mcp',
        'http://localhost/mcp',
        'http://[::1]/mcp',
        'http://0.0.0.0/mcp',
        'http://169.254.169.254/latest',
        'http://[fe80::1]/mcp',
        'http://metadata.google.internal/mcp',
        'http://100.100.100.200/mcp',
        'http://[::ffff:127.0.0.1]/mcp',
      ]) {
        const { mockPrisma, res } = await create(target, true);
        expect(res.statusCode, target).toBe(400);
        expect(mockPrisma.connection.create, target).not.toHaveBeenCalled();
      }
    });

    it('does not persist the flag when it is off', async () => {
      const { mockPrisma } = await create('https://mcp.example.com/mcp', false);
      expect(mockPrisma.connection.create.mock.calls[0]?.[0].data.config).toEqual({
        url: 'https://mcp.example.com/mcp',
      });
    });

    it('refuses a private edit without the opt-in and a loopback one with it', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { url: 'https://mcp.example.com/mcp' },
        id: ID,
        name: 'docs',
        type: 'mcp',
      });
      const patch = (body: Record<string, unknown>) =>
        app.inject({ body, headers: AUTH, method: 'PATCH', url: `${BASE}/${ID}` });
      expect((await patch({ name: 'x', url: 'http://10.0.0.5/mcp' })).statusCode).toBe(400);
      expect(
        (await patch({ allowPrivateNetwork: true, name: 'x', url: 'http://127.0.0.1/mcp' }))
          .statusCode
      ).toBe(400);
      expect(mockPrisma.connection.update).not.toHaveBeenCalled();
    });

    it('the test probe honours the saved flag and still refuses loopback and metadata', async () => {
      const { app, mockPrisma } = await buildApp();
      const test = () => app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${ID}/test` });
      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { url: 'http://10.0.0.5/mcp' },
        id: ID,
      });
      expect(JSON.parse((await test()).payload).data.ok).toBe(false);
      expect(probeMcpServer).not.toHaveBeenCalled();

      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { allowPrivateNetwork: true, url: 'http://10.0.0.5/mcp' },
        id: ID,
      });
      expect(JSON.parse((await test()).payload).data.ok).toBe(true);
      expect(probeMcpServer).toHaveBeenCalledTimes(1);

      for (const url of ['http://127.0.0.1/mcp', 'http://169.254.169.254/']) {
        mockPrisma.connection.findFirst.mockResolvedValue({
          config: { allowPrivateNetwork: true, url },
          id: ID,
        });
        expect(JSON.parse((await test()).payload).data.ok).toBe(false);
      }
      expect(probeMcpServer).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom headers', () => {
    const BASE = '/api/v1/platform/mcp-connections';
    const SECRET = 'tenant-secret-value-9876';
    const URL_OK = 'https://mcp.example.com/mcp';

    function rowWithHeaders(headers: { name: string; value: string }[], over = {}) {
      return {
        config: { url: URL_OK },
        id: ID,
        name: 'docs',
        type: 'mcp',
        ...sealMcpHeaders(headers),
        ...over,
      };
    }

    async function createWith(headers: unknown) {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.team.findUnique.mockResolvedValue({ id: TEAM, isActive: true });
      mockPrisma.connection.create.mockImplementation(async ({ data }) => ({
        id: ID,
        type: 'mcp',
        ...data,
      }));
      const res = await app.inject({
        body: { headers, name: 'docs', teamId: TEAM, url: URL_OK },
        headers: AUTH,
        method: 'POST',
        url: BASE,
      });
      return { app, mockPrisma, res };
    }

    it('seals created headers, returns names only and audits names only', async () => {
      const { mockPrisma, res } = await createWith([
        { name: 'X-Api-Key', value: SECRET },
        { name: 'X-Tenant', value: 'acme' },
      ]);
      expect(res.statusCode).toBe(201);
      const data = mockPrisma.connection.create.mock.calls[0]?.[0].data;
      expect(JSON.stringify(data.config)).not.toContain(SECRET);
      expect(Buffer.from(data.headersCiphertext).toString('utf8')).not.toContain(SECRET);
      expect(openMcpHeaders(data)).toEqual([
        { name: 'X-Api-Key', value: SECRET },
        { name: 'X-Tenant', value: 'acme' },
      ]);
      const body = JSON.parse(res.payload).data;
      expect(body.headerNames).toEqual(['X-Api-Key', 'X-Tenant']);
      expect(res.payload).not.toContain(SECRET);
      expect(res.payload).not.toContain('headersCiphertext');
      const audit = JSON.stringify(mockPrisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain(SECRET);
      expect(audit).toContain('X-Api-Key');
    });

    it('refuses forbidden, malformed, duplicate and excess headers', async () => {
      const bad: unknown[] = [
        [{ name: 'Authorization', value: 'Bearer x' }],
        [{ name: 'authorization', value: 'x' }],
        [{ name: 'Connection', value: 'close' }],
        [{ name: 'Keep-Alive', value: '1' }],
        [{ name: 'Proxy-Authorization', value: 'x' }],
        [{ name: 'Proxy-Foo', value: 'x' }],
        [{ name: 'TE', value: 'x' }],
        [{ name: 'Trailer', value: 'x' }],
        [{ name: 'Transfer-Encoding', value: 'chunked' }],
        [{ name: 'Upgrade', value: 'x' }],
        [{ name: 'Host', value: 'evil.example' }],
        [{ name: 'Content-Length', value: '1' }],
        [{ name: 'Cookie', value: 'a=b' }],
        [{ name: 'mcp-session-id', value: 'x' }],
        [{ name: 'Bad Name', value: 'x' }],
        [{ name: 'X-A', value: 'line\nbreak' }],
        [
          { name: 'X-A', value: '1' },
          { name: 'x-a', value: '2' },
        ],
        Array.from({ length: 6 }, (_, i) => ({ name: `X-H${i}`, value: 'v' })),
      ];
      for (const headers of bad) {
        const { mockPrisma, res } = await createWith(headers);
        expect(res.statusCode, JSON.stringify(headers)).toBe(400);
        expect(mockPrisma.connection.create).not.toHaveBeenCalled();
      }
    });

    it('lists header names and never values', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findMany.mockResolvedValue([
        rowWithHeaders([{ name: 'X-Api-Key', value: SECRET }]),
      ]);
      const res = await app.inject({ headers: AUTH, method: 'GET', url: BASE });
      expect(res.payload).not.toContain(SECRET);
      expect(JSON.parse(res.payload).data[0].headerNames).toEqual(['X-Api-Key']);
    });

    it('keeps a stored value for a row sent without one, and replaces one sent with a value', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(
        rowWithHeaders([
          { name: 'X-Api-Key', value: SECRET },
          { name: 'X-Old', value: 'gone' },
        ])
      );
      mockPrisma.connection.update.mockImplementation(async ({ data }) => ({
        id: ID,
        type: 'mcp',
        ...data,
      }));
      const res = await app.inject({
        body: {
          headers: [{ name: 'x-api-key' }, { name: 'X-New', value: 'fresh' }],
          name: 'docs',
          url: URL_OK,
        },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(200);
      const data = mockPrisma.connection.update.mock.calls[0]?.[0].data;
      expect(openMcpHeaders(data)).toEqual([
        { name: 'x-api-key', value: SECRET },
        { name: 'X-New', value: 'fresh' },
      ]);
      expect(res.payload).not.toContain(SECRET);
      const audit = JSON.stringify(mockPrisma.configAuditLog.create.mock.calls);
      expect(audit).not.toContain(SECRET);
      expect(audit).not.toContain('fresh');
    });

    it('removes every header with an empty list and leaves them alone when omitted', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(
        rowWithHeaders([{ name: 'X-Api-Key', value: SECRET }])
      );
      mockPrisma.connection.update.mockImplementation(async ({ data }) => ({
        id: ID,
        type: 'mcp',
        ...data,
      }));
      const patch = (body: Record<string, unknown>) =>
        app.inject({ body, headers: AUTH, method: 'PATCH', url: `${BASE}/${ID}` });
      expect((await patch({ headers: [], name: 'docs', url: URL_OK })).statusCode).toBe(200);
      expect(mockPrisma.connection.update.mock.calls[0]?.[0].data).toMatchObject({
        headersCiphertext: null,
      });
      expect((await patch({ name: 'docs', url: URL_OK })).statusCode).toBe(200);
      expect(Object.keys(mockPrisma.connection.update.mock.calls[1]?.[0].data)).not.toContain(
        'headersCiphertext'
      );
    });

    it('refuses a value-less row when nothing is stored for that name', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue({
        config: { url: URL_OK },
        id: ID,
        name: 'docs',
        type: 'mcp',
      });
      const res = await app.inject({
        body: { headers: [{ name: 'X-Api-Key' }], name: 'docs', url: URL_OK },
        headers: AUTH,
        method: 'PATCH',
        url: `${BASE}/${ID}`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('will not move stored header values to a different origin', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(
        rowWithHeaders([{ name: 'X-Api-Key', value: SECRET }])
      );
      const patch = (body: Record<string, unknown>) =>
        app.inject({ body, headers: AUTH, method: 'PATCH', url: `${BASE}/${ID}` });
      const moved = 'https://other.example.com/mcp';
      for (const body of [
        { name: 'docs', url: moved },
        { headers: [{ name: 'X-Api-Key' }], name: 'docs', url: moved },
      ]) {
        const res = await patch(body);
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.payload).error.code).toBe('HEADERS_ORIGIN_CHANGE');
      }
      expect(mockPrisma.connection.update).not.toHaveBeenCalled();
      // Re-entering the value is the explicit approval.
      mockPrisma.connection.update.mockImplementation(async ({ data }) => ({ id: ID, ...data }));
      const ok = await patch({
        headers: [{ name: 'X-Api-Key', value: SECRET }],
        name: 'docs',
        url: moved,
      });
      expect(ok.statusCode).toBe(200);
    });

    it('hands decrypted headers to the probe and reports an unreadable envelope', async () => {
      const { app, mockPrisma } = await buildApp();
      mockPrisma.connection.findFirst.mockResolvedValue(
        rowWithHeaders([{ name: 'X-Api-Key', value: SECRET }])
      );
      const res = await app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${ID}/test` });
      expect(probeMcpServer).toHaveBeenCalledWith(URL_OK, 15_000, undefined, {
        bearerToken: undefined,
        headers: [{ name: 'X-Api-Key', value: SECRET }],
      });
      expect(res.payload).not.toContain(SECRET);

      vi.mocked(probeMcpServer).mockClear();
      mockPrisma.connection.findFirst.mockResolvedValue(
        rowWithHeaders([], { headersCiphertext: new Uint8Array(8) })
      );
      const bad = await app.inject({ headers: AUTH, method: 'POST', url: `${BASE}/${ID}/test` });
      expect(JSON.parse(bad.payload).data.ok).toBe(false);
      expect(probeMcpServer).not.toHaveBeenCalled();
    });
  });
});
