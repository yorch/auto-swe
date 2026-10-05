import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConnectionRoutes } from './mcpConnections.js';

vi.mock('../lib/mcpProbe.js', () => ({
  probeMcpServer: vi.fn(async () => ({ durationMs: 12, ok: true, toolCount: 3, toolNames: ['a'] })),
}));

import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
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
});
