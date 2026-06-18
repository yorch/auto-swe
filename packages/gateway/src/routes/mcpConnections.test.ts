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
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/admin' });
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
      url: '/api/v1/admin/mcp-connections',
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
      url: '/api/v1/admin/mcp-connections',
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
      url: '/api/v1/admin/mcp-connections',
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

  it('404s when the team is missing', async () => {
    const { app, mockPrisma } = await buildApp();
    mockPrisma.team.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      body: { name: 'docs', teamId: TEAM, url: 'https://mcp.example.com/mcp' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/admin/mcp-connections',
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
      url: '/api/v1/admin/mcp-connections',
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
      url: `/api/v1/admin/mcp-connections/${ID}`,
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
      url: `/api/v1/admin/mcp-connections/${ID}`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
