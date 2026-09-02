import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

import { agentLibraryRoutes, teamAgentLibraryRoutes } from './agentLibrary.js';

function newMockPrisma() {
  return {
    agent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ skillRefs: [] }),
      updateMany: vi.fn(),
    },
    agentSkillRef: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findUnique: vi.fn() },
    // P5: org-scoped agent creation validates the org exists via this lookup.
    organization: { findUnique: vi.fn() },
    // Channel assistant Phase 1: CHANNEL-scoped agent creation validates the channel exists.
    slackChannel: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    teamMembership: { findUnique: vi.fn() },
    workflowTemplate: { findUnique: vi.fn() },
  };
}

async function buildAdminApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, mockPrisma };
}

async function buildTeamApp(membershipRole: 'ADMIN' | 'ENGINEER' | null) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mockPrisma = newMockPrisma();
  mockPrisma.teamMembership.findUnique.mockResolvedValue(
    membershipRole ? { role: membershipRole } : null
  );
  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'u-1' }),
  } as unknown as never);
  await app.register(teamAgentLibraryRoutes, { prefix: '/api/v1/teams' });
  await app.ready();
  return { app, mockPrisma };
}

const AUTH = { authorization: 'Bearer fake' };
const TEAM = '11111111-1111-4111-8111-111111111111';

beforeEach(() => vi.clearAllMocks());

describe('agentLibraryRoutes — admin', () => {
  it('lists only the latest version per lineage', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'a2', key: 'a', scope: 'GLOBAL', teamId: null, version: 2, workflowTemplateId: null },
      { id: 'a1', key: 'a', scope: 'GLOBAL', teamId: null, version: 1, workflowTemplateId: null },
      { id: 'b1', key: 'b', scope: 'GLOBAL', teamId: null, version: 1, workflowTemplateId: null },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.map((r: { id: string }) => r.id)).toEqual(['a2', 'b1']);
    await app.close();
  });

  it('rejects a non-admin', async () => {
    const { app } = await buildAdminApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // Regression: z.coerce.boolean() treats the *string* "false" as truthy
  // (Boolean("false") === true), so ?all=false used to behave like ?all=true
  // and return every version instead of just the latest.
  it('lists only the latest version per lineage when all=false is explicit', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'a2', key: 'a', scope: 'GLOBAL', teamId: null, version: 2, workflowTemplateId: null },
      { id: 'a1', key: 'a', scope: 'GLOBAL', teamId: null, version: 1, workflowTemplateId: null },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/agent-library?all=false',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.map((r: { id: string }) => r.id)).toEqual(['a2']);
    await app.close();
  });

  it('lists every version per lineage when all=true', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findMany.mockResolvedValue([
      { id: 'a2', key: 'a', scope: 'GLOBAL', teamId: null, version: 2, workflowTemplateId: null },
      { id: 'a1', key: 'a', scope: 'GLOBAL', teamId: null, version: 1, workflowTemplateId: null },
    ]);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/agent-library?all=true',
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(data.map((r: { id: string }) => r.id)).toEqual(['a2', 'a1']);
    await app.close();
  });

  it('rejects an all value other than true/false', async () => {
    const { app } = await buildAdminApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: '/api/v1/platform/agent-library?all=1',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates a new GLOBAL agent (v1) and audits it', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findFirst.mockResolvedValue(null); // maxVersion = 0
    mockPrisma.agent.create.mockResolvedValue({
      id: 'new-1',
      key: 'myAgent',
      name: 'My Agent',
      scope: 'GLOBAL',
      version: 1,
    });
    mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
      id: 'new-1',
      key: 'myAgent',
      name: 'My Agent',
      scope: 'GLOBAL',
      skillRefs: [],
      version: 1,
    });
    const res = await app.inject({
      body: { key: 'myAgent', name: 'My Agent', scope: 'GLOBAL', systemPrompt: 'hi' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).data.id).toBe('new-1');
    expect(mockPrisma.configAuditLog.create).toHaveBeenCalled();
    await app.close();
  });

  it("accepts 'mcp' in toolKeys (WS2)", async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findFirst.mockResolvedValue(null);
    mockPrisma.agent.create.mockResolvedValue({ id: 'mcp-1', key: 'mcpAgent', version: 1 });
    const res = await app.inject({
      body: { key: 'mcpAgent', name: 'MCP Agent', scope: 'GLOBAL', toolKeys: ['bash', 'mcp'] },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects an unknown tool key', async () => {
    const { app } = await buildAdminApp();
    const res = await app.inject({
      body: { key: 'x', name: 'X', scope: 'GLOBAL', toolKeys: ['bogusTool'] },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('creates an agent with a valid mcpConnectionId (P2/WS3)', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'mcp-conn',
      isActive: true,
      teamId: 'team-x',
      type: 'mcp',
    });
    mockPrisma.agent.findFirst.mockResolvedValue(null);
    mockPrisma.agent.create.mockResolvedValue({ id: 'a-1', key: 'mcpA', version: 1 });
    const res = await app.inject({
      body: {
        key: 'mcpA',
        mcpConnectionId: '22222222-2222-4222-8222-222222222222',
        name: 'MCP A',
        scope: 'GLOBAL',
        toolKeys: ['bash', 'mcp'],
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(201);
    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mcpConnectionId: '22222222-2222-4222-8222-222222222222' }),
      })
    );
    await app.close();
  });

  it('400s when mcpConnectionId points at a non-mcp connection', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.connection.findUnique.mockResolvedValue({
      id: 'git-conn',
      isActive: true,
      teamId: 'team-x',
      type: 'git_repo',
    });
    const res = await app.inject({
      body: {
        key: 'badMcp',
        mcpConnectionId: '22222222-2222-4222-8222-222222222222',
        name: 'Bad',
        scope: 'GLOBAL',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('INVALID_MCP_CONNECTION');
    await app.close();
  });

  it('creates a CHANNEL-scoped agent (channel assistant Phase 1)', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.slackChannel.findUnique.mockResolvedValue({ id: 'chan-1' });
    mockPrisma.agent.findFirst.mockResolvedValue(null); // maxVersion = 0
    mockPrisma.agent.create.mockResolvedValue({
      channelId: '44444444-4444-4444-8444-444444444444',
      id: 'chan-agent-1',
      key: 'channelAssistant',
      name: 'Channel Assistant',
      scope: 'CHANNEL',
      version: 1,
    });
    mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
      channelId: '44444444-4444-4444-8444-444444444444',
      id: 'chan-agent-1',
      key: 'channelAssistant',
      name: 'Channel Assistant',
      scope: 'CHANNEL',
      skillRefs: [],
      version: 1,
    });
    const res = await app.inject({
      body: {
        channelId: '44444444-4444-4444-8444-444444444444',
        key: 'channelAssistant',
        name: 'Channel Assistant',
        scope: 'CHANNEL',
      },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(201);
    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channelId: '44444444-4444-4444-8444-444444444444' }),
      })
    );
    await app.close();
  });

  it('400s when a CHANNEL-scope create omits channelId', async () => {
    const { app } = await buildAdminApp();
    const res = await app.inject({
      body: { key: 'channelAssistant', name: 'Channel Assistant', scope: 'CHANNEL' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('409s when the lineage already exists', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findFirst.mockResolvedValue({ version: 1 }); // maxVersion = 1
    const res = await app.inject({
      body: { key: 'reviewer', name: 'Reviewer', scope: 'GLOBAL' },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('400s when a TEAM-scope create names a missing team', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.team.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      body: { key: 'x', name: 'X', scope: 'TEAM', teamId: TEAM },
      headers: AUTH,
      method: 'POST',
      url: '/api/v1/platform/agent-library',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('cuts a new version on update', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findUnique.mockResolvedValue({
      credentialId: null,
      description: null,
      id: '33333333-3333-4333-8333-333333333333',
      inheritsModelFrom: null,
      isBuiltIn: true,
      isVerified: true,
      key: 'reviewer',
      modelSpec: null,
      name: 'Reviewer',
      origin: 'swe-starter',
      scope: 'GLOBAL',
      systemPrompt: null,
      teamId: null,
      toolKeys: null,
      version: 1,
      workflowTemplateId: null,
    });
    mockPrisma.agent.findFirst.mockResolvedValue({ version: 1 }); // maxVersion = 1
    mockPrisma.agent.create.mockResolvedValue({ id: 'v2', key: 'reviewer', version: 2 });
    mockPrisma.agent.findUniqueOrThrow.mockResolvedValue({
      id: 'v2',
      key: 'reviewer',
      skillRefs: [],
      version: 2,
    });
    const res = await app.inject({
      body: { modelSpec: 'anthropic/claude-opus-4-8' },
      headers: AUTH,
      method: 'PUT',
      url: '/api/v1/platform/agent-library/33333333-3333-4333-8333-333333333333',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.version).toBe(2);
    expect(mockPrisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 2 }) })
    );
    await app.close();
  });

  it('deactivates a lineage on delete', async () => {
    const { app, mockPrisma } = await buildAdminApp();
    mockPrisma.agent.findUnique.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      key: 'reviewer',
      scope: 'GLOBAL',
      teamId: null,
      workflowTemplateId: null,
    });
    mockPrisma.agent.updateMany.mockResolvedValue({ count: 3 });
    const res = await app.inject({
      headers: AUTH,
      method: 'DELETE',
      url: '/api/v1/platform/agent-library/33333333-3333-4333-8333-333333333333',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.deactivated).toBe(3);
    await app.close();
  });
});

describe('teamAgentLibraryRoutes — team owner', () => {
  it('lets a team ADMIN create a TEAM agent', async () => {
    const { app, mockPrisma } = await buildTeamApp('ADMIN');
    mockPrisma.agent.findFirst.mockResolvedValue(null);
    mockPrisma.agent.create.mockResolvedValue({
      id: 't-1',
      key: 'teamAgent',
      scope: 'TEAM',
      version: 1,
    });
    const res = await app.inject({
      body: { key: 'teamAgent', name: 'Team Agent' },
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/teams/${TEAM}/agent-library`,
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('rejects a non-admin team member', async () => {
    const { app } = await buildTeamApp('ENGINEER');
    const res = await app.inject({
      body: { key: 'teamAgent', name: 'Team Agent' },
      headers: AUTH,
      method: 'POST',
      url: `/api/v1/teams/${TEAM}/agent-library`,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
