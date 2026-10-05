import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateSkill = vi.fn();
vi.mock('../lib/skillLibraryService.js', () => ({
  updateSkill: (...a: unknown[]) => updateSkill(...a),
}));

import { skillRevisionRoutes } from './skillRevisions.js';

const ID = '00000000-0000-4000-8000-000000000001';

function newMockPrisma() {
  return {
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    skill: {
      findUnique: vi.fn().mockResolvedValue({
        currentRevision: 3,
        description: 'now',
        id: ID,
        isBuiltIn: false,
        promptText: 'text 3',
      }),
    },
    skillRevision: {
      findMany: vi.fn().mockResolvedValue([
        {
          createdBy: { email: 'a@x.dev' },
          description: 'now',
          promptText: 'text 3',
          referenceFiles: [{ content: 'big', path: 'a.md' }],
          revision: 3,
        },
        {
          createdBy: null,
          description: null,
          promptText: 'text 2',
          referenceFiles: null,
          revision: 2,
        },
      ]),
      findUnique: vi
        .fn()
        .mockResolvedValue({ description: 'old', promptText: 'text 1', revision: 1 }),
    },
  };
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
  await app.register(skillRevisionRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  return { app, prisma };
}

const AUTH = { authorization: 'Bearer fake' };
beforeEach(() => {
  vi.clearAllMocks();
  updateSkill.mockResolvedValue({ scanWarnings: [], updated: { currentRevision: 4, id: ID } });
});

describe('GET /skills/:id/revisions', () => {
  it('lists revisions newest first, flags the current one and drops reference files', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/skills/${ID}/revisions`,
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.map((r: { revision: number }) => r.revision)).toEqual([3, 2]);
    expect(data[0]).toMatchObject({ createdByEmail: 'a@x.dev', isCurrent: true });
    expect(data[0].referenceFiles).toBeUndefined();
    expect(data[1].isCurrent).toBe(false);
  });

  it('is ADMIN-only', async () => {
    const { app } = await buildApp('ENGINEER');
    const res = await app.inject({
      headers: AUTH,
      method: 'GET',
      url: `/api/v1/platform/skills/${ID}/revisions`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /skills/:id/revisions/:revision/restore', () => {
  const url = `/api/v1/platform/skills/${ID}/revisions/1/restore`;

  it('writes the old text as a new revision', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(201);
    expect(updateSkill.mock.calls[0][2]).toEqual({ description: 'old', promptText: 'text 1' });
    // Not imported: the empty provenance stops the service guessing from the current revision.
    expect(updateSkill.mock.calls[0][4]).toEqual({});
  });

  it("carries an imported revision's source commit, path and files onto the new revision", async () => {
    const { app, prisma } = await buildApp();
    prisma.skillRevision.findUnique.mockResolvedValue({
      description: 'old',
      promptText: 'text 1',
      referenceFiles: [{ content: 'c', path: 'a.md' }],
      revision: 1,
      sourcePath: 'skills/x/SKILL.md',
      sourceSha: 'abc123',
    });
    await app.inject({ headers: AUTH, method: 'POST', url });
    expect(updateSkill.mock.calls[0][4]).toEqual({
      referenceFiles: [{ content: 'c', path: 'a.md' }],
      sourcePath: 'skills/x/SKILL.md',
      sourceSha: 'abc123',
    });
  });

  it('refuses to restore the current revision', async () => {
    const { app, prisma } = await buildApp();
    prisma.skillRevision.findUnique.mockResolvedValue({
      description: 'now',
      promptText: 'text 3',
      revision: 3,
    });
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(409);
    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('refuses a built-in skill', async () => {
    const { app, prisma } = await buildApp();
    prisma.skill.findUnique.mockResolvedValue({ currentRevision: 3, id: ID, isBuiltIn: true });
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown revision', async () => {
    const { app, prisma } = await buildApp();
    prisma.skillRevision.findUnique.mockResolvedValue(null);
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(404);
  });

  it('turns a lost race into 409', async () => {
    const { app } = await buildApp();
    updateSkill.mockRejectedValue(Object.assign(new Error('x'), { code: 'P2025' }));
    const res = await app.inject({ headers: AUTH, method: 'POST', url });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_CHANGED');
  });
});
