import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

import { agentVersionRoutes } from './agentVersions.js';

const ID = '00000000-0000-4000-8000-000000000001';
const V1 = '00000000-0000-4000-8000-0000000000a1';
const V2 = '00000000-0000-4000-8000-0000000000a2';
const SKILL = '00000000-0000-4000-8000-0000000000b1';

function row(version: number, over: Record<string, unknown> = {}) {
  return {
    channelId: null,
    createdById: 'u1',
    credentialId: null,
    description: null,
    id: version === 1 ? V1 : V2,
    inheritsModelFrom: null,
    isActive: true,
    isBuiltIn: false,
    isVerified: true,
    key: 'reviewer',
    mcpConnectionId: null,
    modelSpec: `anthropic/model-${version}`,
    name: 'Reviewer',
    orgId: null,
    origin: null,
    scope: 'GLOBAL',
    skillRefs: [],
    systemPrompt: `prompt ${version}`,
    teamId: null,
    toolKeys: null,
    version,
    workflowTemplateId: null,
    ...over,
  };
}

function newMockPrisma() {
  const prisma = {
    agent: {
      create: vi.fn().mockResolvedValue({ id: 'new' }),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([row(2), row(1)]),
      findUnique: vi.fn().mockResolvedValue(row(2)),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...row(3), skillRefs: [] }),
    },
    agentSkillRef: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: { findUnique: vi.fn() },
    modelCatalogEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    skill: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([{ email: 'a@x.dev', id: 'u1' }]) },
  };
  return Object.assign(prisma, {
    $transaction: async (arg: unknown) => (arg as (tx: typeof prisma) => Promise<unknown>)(prisma),
  });
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = newMockPrisma();
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'admin-1' }),
  } as unknown as never);
  await app.register(agentVersionRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
beforeEach(() => vi.clearAllMocks());

describe('GET /agent-library/:id/versions', () => {
  it('is ADMIN-only', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/agent-library/${ID}/versions`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists every version of the lineage with its author', async () => {
    const { app, prisma } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/agent-library/${ID}/versions`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(data[0].createdByEmail).toBe('a@x.dev');
    // The lineage filter pins every scope key, channel included.
    expect(prisma.agent.findMany.mock.calls[0][0].where).toMatchObject({
      channelId: null,
      key: 'reviewer',
      scope: 'GLOBAL',
    });
  });

  it('404s for an unknown agent', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/agent-library/${ID}/versions`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /agent-library/:id/restore', () => {
  it('cuts a new version from the chosen old one', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst
      .mockResolvedValueOnce(row(1, { skillRefs: [{ skillId: SKILL, sortOrder: 0 }] }))
      .mockResolvedValueOnce(row(2)) // latest
      .mockResolvedValueOnce({ version: 2 }); // maxVersion
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(201);
    const created = prisma.agent.create.mock.calls[0][0].data;
    expect(created.version).toBe(3);
    expect(created.modelSpec).toBe('anthropic/model-1');
    expect(created.systemPrompt).toBe('prompt 1');
    expect(created.isVerified).toBe(false);
    expect(prisma.agentSkillRef.createMany.mock.calls[0][0].data[0].skillId).toBe(SKILL);
    expect(prisma.configAuditLog.create).toHaveBeenCalled();
  });

  it('keeps verification when the prompt is unchanged', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst
      .mockResolvedValueOnce(row(1, { systemPrompt: 'same' }))
      .mockResolvedValueOnce(row(2, { systemPrompt: 'same' }))
      .mockResolvedValueOnce({ version: 2 });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(201);
    expect(prisma.agent.create.mock.calls[0][0].data.isVerified).toBe(true);
  });

  it('refuses a version whose MCP connection is no longer usable', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst
      .mockResolvedValueOnce(row(1, { mcpConnectionId: 'conn-1' }))
      .mockResolvedValueOnce(row(2));
    prisma.connection.findUnique.mockResolvedValue({ isActive: false, type: 'mcp' });
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_MCP_CONNECTION');
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('refuses to restore into a deactivated lineage', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst
      .mockResolvedValueOnce(row(1))
      .mockResolvedValueOnce(row(2, { isActive: false }));
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(409);
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });

  it('warns, without failing, about a skill that has been deactivated', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst
      .mockResolvedValueOnce(row(1, { skillRefs: [{ skillId: SKILL, sortOrder: 0 }] }))
      .mockResolvedValueOnce(row(2))
      .mockResolvedValueOnce({ version: 2 });
    prisma.skill.findMany.mockResolvedValue([{ name: 'Careful reviewer' }]);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().skillWarnings[0]).toMatch(/Careful reviewer/);
  });

  it('refuses a version from another lineage', async () => {
    const { app, prisma } = await buildApp();
    prisma.agent.findFirst.mockResolvedValueOnce(null);
    const res = await app.inject({
      headers: AUTH,
      method: 'POST',
      payload: { versionId: V1 },
      url: `/api/v1/platform/agent-library/${ID}/restore`,
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.agent.create).not.toHaveBeenCalled();
  });
});
