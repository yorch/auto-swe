import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workflowTemplateRoutes } from './workflowTemplates.js';

type Mutable = Record<string, unknown>;

interface FakeTemplate {
  id: string;
  name: string;
  description: string;
  status: string;
  isDefault: boolean;
  activeVersion: number | null;
  teamId: string | null;
  team: { id: string; name: string; slug: string } | null;
  createdAt: Date;
  updatedAt: Date;
  versions: Array<{ id: string; version: number; createdAt: Date; createdBy: string | null }>;
}

const VALID_SPEC = {
  description: '',
  entry: 'start',
  name: 'minimal',
  nodes: { start: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 3,
};

function buildApp(state: {
  templates: FakeTemplate[];
  versions: Map<string, { spec: unknown; createdAt: Date; createdBy: string | null }>;
  runs: Array<{
    id: string;
    templateId: string;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
  }>;
  userRole?: string;
}): FastifyInstance {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: state.userRole ?? 'LEAD',
      sub: 'user-1',
    }),
  } as unknown as never);

  const findTemplate = (where: Mutable): FakeTemplate | undefined =>
    state.templates.find(
      (t) =>
        (where.id === undefined || t.id === where.id) &&
        (where.teamId === undefined || t.teamId === where.teamId)
    );

  app.decorate('prisma', {
    teamMembership: {
      findFirst: async () => ({ teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567', userId: 'user-1' }),
    },
    workflowRun: {
      count: async ({ where }: { where?: Mutable }) =>
        state.runs.filter((r) => !where?.templateId || r.templateId === where.templateId).length,
      findMany: async ({ where, distinct }: { where?: Mutable; distinct?: string[] }) => {
        const filtered = state.runs.filter((r) => {
          if (!where?.templateId) return true;
          const ids = (where.templateId as { in?: string[] }).in;
          return ids ? ids.includes(r.templateId) : where.templateId === r.templateId;
        });
        if (!distinct) return filtered;
        const seen = new Set<string>();
        return filtered.filter((r) => {
          if (seen.has(r.templateId)) return false;
          seen.add(r.templateId);
          return true;
        });
      },
    },
    workflowTemplate: {
      create: async ({
        data,
      }: {
        data: Mutable & { versions?: { create: { spec: unknown; version: number } } };
      }) => {
        const idx = state.templates.length + 1;
        const id = `00000000-0000-4000-8000-00000000000${idx}`;
        const tpl: FakeTemplate = {
          activeVersion: (data.activeVersion as number | null) ?? null,
          createdAt: new Date(),
          description: (data.description as string) ?? '',
          id,
          isDefault: false,
          name: data.name as string,
          status: (data.status as string) ?? 'DRAFT',
          team: null,
          teamId: (data.teamId as string | null) ?? null,
          updatedAt: new Date(),
          versions: [],
        };
        if (data.versions?.create) {
          const versionId = `v-${id}-1`;
          tpl.versions.push({
            createdAt: new Date(),
            createdBy: 'user-1',
            id: versionId,
            version: data.versions.create.version,
          });
          state.versions.set(`${id}:${data.versions.create.version}`, {
            createdAt: new Date(),
            createdBy: 'user-1',
            spec: data.versions.create.spec,
          });
        }
        state.templates.push(tpl);
        return { ...tpl, _count: { versions: tpl.versions.length } };
      },
      findFirst: async ({ where }: { where?: Mutable }) => {
        const tpl = findTemplate(where ?? {});
        return tpl ? { ...tpl, _count: { versions: tpl.versions.length } } : null;
      },
      findMany: async ({ where }: { where?: Mutable }) => {
        const filtered = state.templates.filter((t) => {
          if (where?.teamId && t.teamId !== where.teamId) return false;
          return true;
        });
        return filtered.map((t) => ({ ...t, _count: { versions: t.versions.length } }));
      },
      update: async ({ data, where }: { data: Mutable; where: Mutable }) => {
        const tpl = findTemplate(where);
        if (!tpl) throw new Error('not found');
        Object.assign(tpl, data);
        tpl.updatedAt = new Date();
        return { ...tpl, _count: { versions: tpl.versions.length } };
      },
      updateMany: async ({ data, where }: { data: Mutable; where: Mutable }) => {
        let count = 0;
        for (const t of state.templates) {
          if (where.teamId !== undefined && t.teamId !== where.teamId) continue;
          if (where.id && (where.id as { not?: string }).not === t.id) continue;
          Object.assign(t, data);
          count++;
        }
        return { count };
      },
    },
    workflowTemplateVersion: {
      create: async ({ data }: { data: Mutable }) => {
        const id = `v-${data.templateId}-${data.version}`;
        const tpl = findTemplate({ id: data.templateId });
        if (!tpl) throw new Error('template not found');
        tpl.versions.push({
          createdAt: new Date(),
          createdBy: 'user-1',
          id,
          version: data.version as number,
        });
        state.versions.set(`${data.templateId}:${data.version}`, {
          createdAt: new Date(),
          createdBy: 'user-1',
          spec: data.spec,
        });
        return {
          ...(state.versions.get(`${data.templateId}:${data.version}`) as Mutable),
          id,
          templateId: data.templateId,
          version: data.version,
        };
      },
      findFirst: async ({ where, orderBy: _ }: { where?: Mutable; orderBy?: Mutable }) => {
        const tpl = findTemplate({ id: where?.templateId });
        if (!tpl) return null;
        const sorted = [...tpl.versions].sort((a, b) => b.version - a.version);
        return sorted[0] ?? null;
      },
      findUnique: async ({ where }: { where: Mutable }) => {
        const composite = where.templateId_version as { templateId: string; version: number };
        const v = state.versions.get(`${composite.templateId}:${composite.version}`);
        if (!v) return null;
        return { ...v, templateId: composite.templateId, version: composite.version };
      },
    },
  } as unknown as never);

  app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  return app;
}

describe('workflow-templates routes', () => {
  let app: FastifyInstance;
  let state: Parameters<typeof buildApp>[0];

  beforeAll(async () => {
    state = {
      runs: [],
      templates: [],
      versions: new Map(),
    };
    app = buildApp(state);
    await app.ready();
  });

  afterAll(() => app.close());

  it('rejects POST without a valid spec', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'bad',
        spec: { schemaVersion: 99 },
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect.soft(json, JSON.stringify(json)).toHaveProperty('error.code');
    expect(json.error?.code).toBe('INVALID_SPEC');
  });

  it('creates a template + initial version + promotes to active', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'engineering',
        spec: VALID_SPEC,
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.activeVersion).toBe(1);
    expect(body.data.status).toBe('ACTIVE');
    expect(body.data.versionCount).toBe(1);
  });

  it('lists templates with last run summary', async () => {
    const tpl = state.templates[0];
    if (tpl) {
      state.runs.push({
        endedAt: null,
        id: 'run-1',
        startedAt: new Date(),
        status: 'RUNNING',
        templateId: tpl.id,
      });
    }
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(state.templates.length);
    const first = body.data[0];
    expect(first.lastRun?.status).toBe('RUNNING');
  });

  it('creates a new version with monotonically increasing number', async () => {
    const tpl = state.templates[0];
    if (!tpl) throw new Error('expected template');
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { spec: VALID_SPEC },
      url: `/api/v1/workflow-templates/${tpl.id}/versions`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.version).toBe(2);
  });

  it('rejects new version with invalid spec', async () => {
    const tpl = state.templates[0];
    if (!tpl) throw new Error('expected template');
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { spec: { schemaVersion: 3 } },
      url: `/api/v1/workflow-templates/${tpl.id}/versions`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('promotes a version to active', async () => {
    const tpl = state.templates[0];
    if (!tpl) throw new Error('expected template');
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { version: 2 },
      url: `/api/v1/workflow-templates/${tpl.id}/promote`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.activeVersion).toBe(2);
  });

  it('returns 404 for unknown template', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});
