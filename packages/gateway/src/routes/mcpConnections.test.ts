import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpConnectionRoutes } from './mcpConnections.js';

function newMockPrisma() {
  return {
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

beforeEach(() => vi.clearAllMocks());

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
});
