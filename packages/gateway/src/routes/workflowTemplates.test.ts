import {
  computeAnalytics,
  computeGlobalAnalytics,
  MIN_SAMPLES_FOR_SIGNIFICANCE,
  SPEC_SCHEMA_VERSION,
} from '@auto-swe/shared/workflow';
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
  experimentVersion: number | null;
  experimentSplit: number | null;
  teamId: string | null;
  team: { id: string; name: string; slug: string } | null;
  workspaceProvider: string | null;
  createdAt: Date;
  updatedAt: Date;
  versions: Array<{ id: string; version: number; createdAt: Date; createdBy: string | null }>;
}

const VALID_SPEC = {
  description: '',
  entry: 'start',
  name: 'minimal',
  nodes: { start: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: SPEC_SCHEMA_VERSION,
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
  teamRole?: string;
  teamAllowlist?: string[];
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

  const shellAudits: Array<{
    templateVersionId: string;
    teamId: string | null;
    authorUserId: string;
    nodeId: string;
    image: string;
    command: string;
    network: string;
  }> = [];
  // exposed via state for assertions
  (state as unknown as { shellAudits: typeof shellAudits }).shellAudits = shellAudits;

  type PrismaMock = Record<string, unknown> & {
    $transaction?: (fn: (tx: PrismaMock) => Promise<unknown>) => Promise<unknown>;
  };
  const prismaMock: PrismaMock = {
    $transaction: async (fn: (tx: PrismaMock) => Promise<unknown>) => fn(prismaMock),
  };

  app.decorate(
    'prisma',
    Object.assign(prismaMock, {
      humanErrorBaseline: {
        findMany: async () =>
          (
            state as {
              humanErrorBaselines?: Array<{
                domain: string;
                errorRate: number;
                outcomeType: string | null;
                sampleSize: number;
              }>;
            }
          ).humanErrorBaselines ?? [],
      },
      team: {
        findUnique: async ({ where }: { where: Mutable }) => {
          // For the shell allowlist check; tests can override via state.teamAllowlist
          return where.id
            ? {
                egressAllowlist: (state as { egressAllowlist?: string[] }).egressAllowlist ?? [],
                id: where.id as string,
                shellImageAllowlist: (state as { teamAllowlist?: string[] }).teamAllowlist ?? [],
              }
            : null;
        },
      },
      teamMembership: {
        findFirst: async () => ({
          teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
          userId: 'user-1',
        }),
        findUnique: async ({ where }: { where: Mutable }) => {
          const composite = where.userId_teamId as { userId: string; teamId: string };
          const teamRole = (state as { teamRole?: string }).teamRole ?? 'LEAD';
          return composite
            ? { role: teamRole, teamId: composite.teamId, userId: composite.userId }
            : null;
        },
      },
      workflowRun: {
        count: async ({ where }: { where?: Mutable }) =>
          state.runs.filter((r) => !where?.templateId || r.templateId === where.templateId).length,
        findMany: async ({
          where,
          distinct,
          take,
        }: {
          where?: Mutable;
          distinct?: string[];
          take?: number;
        }) => {
          const filtered = state.runs.filter((r) => {
            if (!where?.templateId) {
              return true;
            }
            const ids = (where.templateId as { in?: string[] }).in;
            return ids ? ids.includes(r.templateId) : where.templateId === r.templateId;
          });
          const ordered = [...filtered];
          if (typeof take === 'number') {
            return ordered.slice(0, take);
          }
          if (!distinct) {
            return ordered;
          }
          const seen = new Set<string>();
          return ordered.filter((r) => {
            if (seen.has(r.templateId)) {
              return false;
            }
            seen.add(r.templateId);
            return true;
          });
        },
      },
      workflowShellAudit: {
        createMany: async ({ data }: { data: Array<Mutable> }) => {
          for (const row of data) {
            shellAudits.push({
              authorUserId: row.authorUserId as string,
              command: row.command as string,
              image: row.image as string,
              network: (row.network as string) ?? 'none',
              nodeId: row.nodeId as string,
              teamId: row.teamId as string | null,
              templateVersionId: row.templateVersionId as string,
            });
          }
          return { count: data.length };
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
            experimentSplit: null,
            experimentVersion: null,
            id,
            isDefault: false,
            name: data.name as string,
            status: (data.status as string) ?? 'DRAFT',
            team: null,
            teamId: (data.teamId as string | null) ?? null,
            updatedAt: new Date(),
            versions: [],
            workspaceProvider: (data.workspaceProvider as string | null) ?? null,
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
            if (where?.teamId && t.teamId !== where.teamId) {
              return false;
            }
            return true;
          });
          return filtered.map((t) => ({ ...t, _count: { versions: t.versions.length } }));
        },
        update: async ({ data, where }: { data: Mutable; where: Mutable }) => {
          const tpl = findTemplate(where);
          if (!tpl) {
            throw new Error('not found');
          }
          Object.assign(tpl, data);
          tpl.updatedAt = new Date();
          return { ...tpl, _count: { versions: tpl.versions.length } };
        },
        updateMany: async ({ data, where }: { data: Mutable; where: Mutable }) => {
          let count = 0;
          for (const t of state.templates) {
            if (where.teamId !== undefined && t.teamId !== where.teamId) {
              continue;
            }
            if (where.id && (where.id as { not?: string }).not === t.id) {
              continue;
            }
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
          if (!tpl) {
            throw new Error('template not found');
          }
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
          if (!tpl) {
            return null;
          }
          const sorted = [...tpl.versions].sort((a, b) => b.version - a.version);
          const top = sorted[0];
          if (!top) {
            return null;
          }
          // Real Prisma findFirst (no `select`) returns every column, including
          // the stored spec — merge it in so callers that read `.spec` (refine)
          // see it, not just the version metadata kept on `tpl.versions`.
          const stored = state.versions.get(`${where?.templateId}:${top.version}`);
          return { ...top, spec: stored?.spec, templateId: where?.templateId };
        },
        findUnique: async ({ where }: { where: Mutable }) => {
          const composite = where.templateId_version as { templateId: string; version: number };
          const v = state.versions.get(`${composite.templateId}:${composite.version}`);
          if (!v) {
            return null;
          }
          return { ...v, templateId: composite.templateId, version: composite.version };
        },
      },
    }) as unknown as never
  );

  app.decorate('temporal', {
    explainWorkflowSpec: async () => ({ explanation: 'This workflow does X then Y.' }),
    generateWorkflowSpec: async () => {
      const s = state as {
        generateError?: boolean;
        generateInfraError?: boolean;
        generatedSpec?: unknown;
      };
      if (s.generateInfraError) {
        // No author-failure marker → treated as an infra error (503).
        throw new Error('Temporal connection refused');
      }
      if (s.generateError) {
        // Mirrors the activity's thrown message so the route maps it to 422.
        throw new Error(
          'workflowAuthor could not produce a valid WorkflowSpec after 3 attempts: bad spec'
        );
      }
      return { attempts: 1, spec: s.generatedSpec ?? VALID_SPEC, summary: 'generated summary' };
    },
    getWorkflowAuthorJobStatus: async () => {
      const s = state as { jobStatus?: unknown };
      return s.jobStatus ?? { phase: 'generating', status: 'running' };
    },
    startWorkflowAuthorJob: async () => {},
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

  it('defaults workspaceProvider to git_repo when omitted on create', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'default-provider',
        spec: VALID_SPEC,
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.workspaceProvider).toBe('git_repo');
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

  it('saves an unparseable cond expression but surfaces it as a warning (non-blocking)', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'warn-expr',
        spec: {
          entry: 'a',
          name: 'warn-expr',
          nodes: {
            a: { expr: 'x === 1', onFalse: 'd', onTrue: 'd', type: 'cond' },
            d: { status: 'SUCCESS', type: 'terminate' },
          },
          schemaVersion: SPEC_SCHEMA_VERSION,
        },
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
    // Validation is advisory at save time: the template is created, but the
    // unparseable expression is reported in `warnings`.
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.join(' ')).toMatch(/unexpected character/i);
  });

  it('does not flag valid relational expressions over context paths', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'good-expr',
        spec: {
          entry: 'a',
          name: 'good-expr',
          nodes: {
            a: { expr: 'context.retries >= 3', onFalse: 'd', onTrue: 'd', type: 'cond' },
            d: { status: 'SUCCESS', type: 'terminate' },
          },
          schemaVersion: SPEC_SCHEMA_VERSION,
        },
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(201);
    const warnings: string[] = res.json().warnings ?? [];
    expect(warnings.some((w) => /EXPR_SYNTAX|unexpected|requires a number/i.test(w))).toBe(false);
  });

  it('explains a template in plain language', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected a template from the create test');
    }
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      url: `/api/v1/workflow-templates/${tpl.id}/explain`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.explanation).toContain('does X then Y');
  });

  it('returns 404 explaining an unknown template', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      url: '/api/v1/workflow-templates/00000000-0000-4000-8000-0000000000ff/explain',
    });
    expect(res.statusCode).toBe(404);
  });

  it('generates a DRAFT template from a description', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        prompt: 'Open a PR after the implementer runs',
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates/generate',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.status).toBe('DRAFT');
    expect(body.data.activeVersion).toBe(1);
    expect(body.summary).toBe('generated summary');
    expect(body.spec.entry).toBe('start');
  });

  it('applies a name override to the generated draft', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'My Custom Name',
        prompt: 'do something',
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates/generate',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe('My Custom Name');
  });

  it('returns 422 when generation fails', async () => {
    (state as { generateError?: boolean }).generateError = true;
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'x', teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567' },
      url: '/api/v1/workflow-templates/generate',
    });
    (state as { generateError?: boolean }).generateError = false;
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.code).toBe('GENERATION_FAILED');
  });

  it('starts an async generation job and returns a jobId', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'build a flow', teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567' },
      url: '/api/v1/workflow-templates/generate/jobs',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.jobId).toMatch(/^wfauthorjob-/);
  });

  it('polls a running job', async () => {
    (state as { jobStatus?: unknown }).jobStatus = { phase: 'persisting', status: 'running' };
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates/generate/jobs/wfauthorjob-abc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ phase: 'persisting', status: 'running' });
  });

  it('polls a finished job and returns the templateId', async () => {
    (state as { jobStatus?: unknown }).jobStatus = {
      result: { attempts: 1, name: 'Gen', summary: 's', templateId: 'tpl-async' },
      status: 'done',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates/generate/jobs/wfauthorjob-abc',
    });
    (state as { jobStatus?: unknown }).jobStatus = undefined;
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'done', templateId: 'tpl-async' });
  });

  it('returns 503 when generation hits an infrastructure error', async () => {
    (state as { generateInfraError?: boolean }).generateInfraError = true;
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'x', teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567' },
      url: '/api/v1/workflow-templates/generate',
    });
    (state as { generateInfraError?: boolean }).generateInfraError = false;
    expect(res.statusCode).toBe(503);
    expect(res.json().error?.code).toBe('GENERATION_UNAVAILABLE');
  });

  it('forbids a non-admin from generating a global template', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'x' },
      url: '/api/v1/workflow-templates/generate',
    });
    expect(res.statusCode).toBe(403);
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
    if (!tpl) {
      throw new Error('expected template');
    }
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
    if (!tpl) {
      throw new Error('expected template');
    }
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
    if (!tpl) {
      throw new Error('expected template');
    }
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

  it('returns a structural diff between two versions', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected template');
    }
    // Create a third version that adds a node to make the diff non-trivial.
    await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        spec: {
          description: '',
          entry: 'start',
          name: 'minimal',
          nodes: {
            done: { status: 'SUCCESS', type: 'terminate' },
            start: { next: 'done', step: 'runLint', type: 'step' },
          },
          schemaVersion: SPEC_SCHEMA_VERSION,
        },
      },
      url: `/api/v1/workflow-templates/${tpl.id}/versions`,
    });
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: `/api/v1/workflow-templates/${tpl.id}/diff?a=1&b=3`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.a.version).toBe(1);
    expect(body.data.b.version).toBe(3);
    expect(body.data.diff.addedNodes).toContain('done');
    expect(body.data.diff.changedNodes).toContain('start');
  });

  it('rejects experimentSplit > 0 without an experimentVersion', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected template');
    }
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'PATCH',
      payload: { experimentSplit: 50 },
      url: `/api/v1/workflow-templates/${tpl.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('EXPERIMENT_VERSION_REQUIRED');
  });

  it('rejects experimentVersion pointing at a missing version', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected template');
    }
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'PATCH',
      payload: { experimentVersion: 99 },
      url: `/api/v1/workflow-templates/${tpl.id}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('EXPERIMENT_VERSION_NOT_FOUND');
  });

  it('accepts a valid experiment config and round-trips it on detail', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected template');
    }
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'PATCH',
      payload: { experimentSplit: 25, experimentVersion: 2 },
      url: `/api/v1/workflow-templates/${tpl.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.experimentVersion).toBe(2);
    expect(body.data.experimentSplit).toBe(25);
  });
});

// ── Phase 6: shell-step authoring RBAC + image allowlist ──

describe('workflow-templates shell-step RBAC', () => {
  const SHELL_SPEC = {
    description: '',
    entry: 'sh',
    name: 'sh-spec',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      sh: {
        command: 'echo hi',
        image: 'alpine:latest',
        next: 'done',
        type: 'shell',
      },
    },
    schemaVersion: SPEC_SCHEMA_VERSION,
  };
  const TEAM_ID = 'a1b2c3d4-1234-4567-89ab-cdef01234567';

  it('rejects shell-node POST when the author is not a team ADMIN', async () => {
    const state = { runs: [], teamRole: 'LEAD', templates: [], versions: new Map() };
    const app = buildApp(state);
    await app.ready();
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { name: 'sh-tpl', spec: SHELL_SPEC, teamId: TEAM_ID },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toBe('SHELL_AUTHOR_FORBIDDEN');
    await app.close();
  });

  it('rejects shell-node POST on a global template for non-platform-admin users', async () => {
    const state = {
      runs: [],
      teamRole: 'ADMIN',
      templates: [],
      userRole: 'LEAD',
      versions: new Map(),
    };
    const app = buildApp(state);
    await app.ready();
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { name: 'sh-global', spec: SHELL_SPEC, teamId: null },
      url: '/api/v1/workflow-templates',
    });
    // Global creation also requires platform ADMIN — this short-circuits
    // before our shell check fires, returning the existing FORBIDDEN error.
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('accepts shell-node POST from a team ADMIN with an allowlisted image and writes audit rows', async () => {
    const state: Parameters<typeof buildApp>[0] & { shellAudits?: unknown[] } = {
      runs: [],
      teamRole: 'ADMIN',
      templates: [],
      userRole: 'LEAD',
      versions: new Map(),
    };
    const app = buildApp(state);
    await app.ready();
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { name: 'sh-tpl', spec: SHELL_SPEC, teamId: TEAM_ID },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(201);
    expect((state.shellAudits as Array<{ nodeId: string; command: string }>).length).toBe(1);
    expect((state.shellAudits as Array<{ nodeId: string }>)[0]?.nodeId).toBe('sh');
    await app.close();
  });

  it('rejects shell-node POST whose image is not allowlisted for the team', async () => {
    const state = {
      runs: [],
      teamAllowlist: [], // only built-ins
      teamRole: 'ADMIN',
      templates: [],
      userRole: 'LEAD',
      versions: new Map(),
    };
    const app = buildApp(state);
    await app.ready();
    const exoticSpec = {
      ...SHELL_SPEC,
      nodes: {
        ...SHELL_SPEC.nodes,
        sh: { ...SHELL_SPEC.nodes.sh, image: 'rust:1.78-alpine' },
      },
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { name: 'sh-tpl-bad', spec: exoticSpec, teamId: TEAM_ID },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error?.code).toBe('SHELL_IMAGE_NOT_ALLOWED');
    await app.close();
  });

  it('accepts a shell-node image that is on the team-extended allowlist', async () => {
    const state = {
      runs: [],
      teamAllowlist: ['rust:1.78-alpine'],
      teamRole: 'ADMIN',
      templates: [],
      userRole: 'LEAD',
      versions: new Map(),
    };
    const app = buildApp(state);
    await app.ready();
    const exoticSpec = {
      ...SHELL_SPEC,
      nodes: {
        ...SHELL_SPEC.nodes,
        sh: { ...SHELL_SPEC.nodes.sh, image: 'rust:1.78-alpine' },
      },
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { name: 'sh-tpl-ext', spec: exoticSpec, teamId: TEAM_ID },
      url: '/api/v1/workflow-templates',
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe('computeAnalytics', () => {
  it('returns null rates when there are no runs', () => {
    const out = computeAnalytics([], [], 30);
    expect(out.totalRuns).toBe(0);
    expect(out.successRate).toBeNull();
    expect(out.p50DurationMs).toBeNull();
    expect(out.avgCostPerRun).toBeNull();
  });

  it('computes success rate + duration percentiles + per-version counts', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    const minute = 60_000;
    const out = computeAnalytics(
      [
        {
          endedAt: new Date(t0.getTime() + 5 * minute),
          startedAt: t0,
          status: 'SUCCESS',
          templateVersion: 1,
          workRequest: {
            activeWorkflows: [{ costUsdAccrued: 1 }],
          },
        },
        {
          endedAt: new Date(t0.getTime() + 10 * minute),
          startedAt: t0,
          status: 'SUCCESS',
          templateVersion: 1,
          workRequest: {
            activeWorkflows: [{ costUsdAccrued: 3 }],
          },
        },
        {
          endedAt: new Date(t0.getTime() + 1 * minute),
          startedAt: t0,
          status: 'FAILED',
          templateVersion: 2,
          workRequest: {
            activeWorkflows: [{ costUsdAccrued: 2 }],
          },
        },
        // still running — ignored from rates + durations
        {
          endedAt: null,
          startedAt: t0,
          status: 'RUNNING',
          templateVersion: 1,
          workRequest: null,
        },
      ],
      [
        { nodeId: 'lint', status: 'PASSED' },
        { nodeId: 'lint', status: 'FAILED' },
        { nodeId: 'lint', status: 'PASSED' },
        { nodeId: 'test', status: 'PASSED' },
        { nodeId: 'skip-me', status: 'SKIPPED' },
      ],
      30
    );

    expect(out.totalRuns).toBe(4);
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.successRate).toBeCloseTo(2 / 3);
    expect(out.p50DurationMs).toBe(5 * minute);
    expect(out.p95DurationMs).toBe(10 * minute);
    expect(out.totalCost).toBe(6);
    expect(out.avgCostPerRun).toBe(2);
    const lint = out.perStepFailureRates.find((s) => s.nodeId === 'lint');
    expect(lint).toMatchObject({ failed: 1, failureRate: 1 / 3, total: 3 });
    // SKIPPED steps must not appear in the failure rollup.
    expect(out.perStepFailureRates.find((s) => s.nodeId === 'skip-me')).toBeUndefined();
    expect(out.perVersionCounts).toEqual([
      { count: 3, version: 1 },
      { count: 1, version: 2 },
    ]);
    // Phase-8: not enough runs per arm for a significance hint.
    expect(out.significanceHint).toBeNull();
  });

  it('uses nearest-rank percentile indexes at small-sample edges', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    const runs = [1, 2].map((seconds) => ({
      endedAt: new Date(t0.getTime() + seconds * 1000),
      startedAt: t0,
      status: 'SUCCESS',
      templateVersion: 1,
    }));

    const out = computeAnalytics(runs, [], 30);
    expect(out.p50DurationMs).toBe(1000);
    expect(out.p95DurationMs).toBe(2000);
  });

  it('phase 8: prefers denormalized costUsdAccrued column over workRequest join', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    const out = computeAnalytics(
      [
        // Denormalized column wins when present (>0).
        {
          costUsdAccrued: 42,
          endedAt: new Date(t0.getTime() + 1),
          startedAt: t0,
          status: 'SUCCESS',
          templateVersion: 1,
          workRequest: { activeWorkflows: [{ costUsdAccrued: 999 }] },
        },
        // Falls back to workRequest sum when costUsdAccrued is 0.
        {
          costUsdAccrued: 0,
          endedAt: new Date(t0.getTime() + 1),
          startedAt: t0,
          status: 'SUCCESS',
          templateVersion: 1,
          workRequest: { activeWorkflows: [{ costUsdAccrued: 8 }] },
        },
      ],
      [],
      30
    );
    expect(out.totalCost).toBe(50);
  });

  it('only uses the active workflow cost matching the specific run', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    const out = computeAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: new Date(t0.getTime() + 1),
          startedAt: t0,
          status: 'SUCCESS',
          templateVersion: 1,
          workflowId: 'workflow-for-this-run',
          workRequest: {
            activeWorkflows: [
              { costUsdAccrued: 8, temporalWorkflowId: 'workflow-for-this-run' },
              { costUsdAccrued: 999, temporalWorkflowId: 'different-run' },
            ],
          },
        },
      ],
      [],
      30
    );
    expect(out.totalCost).toBe(8);
  });

  it('phase 8: emits significanceHint when both arms cross the sample threshold', () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    // 40 SUCCESS on v1, 40 mixed on v2 → clear gap, plenty of samples.
    const runs = [
      ...Array.from({ length: 40 }, () => ({
        endedAt: new Date(t0.getTime() + 1),
        startedAt: t0,
        status: 'SUCCESS',
        templateVersion: 1,
      })),
      ...Array.from({ length: 30 }, () => ({
        endedAt: new Date(t0.getTime() + 1),
        startedAt: t0,
        status: 'SUCCESS',
        templateVersion: 2,
      })),
      ...Array.from({ length: 10 }, () => ({
        endedAt: new Date(t0.getTime() + 1),
        startedAt: t0,
        status: 'FAILED',
        templateVersion: 2,
      })),
    ];
    const out = computeAnalytics(runs, [], 30);
    expect(out.significanceHint).not.toBeNull();
    expect(out.significanceHint?.versionA).toBe(1);
    expect(out.significanceHint?.successRateA).toBeCloseTo(1);
    expect(out.significanceHint?.successRateB).toBeCloseTo(0.75);
    expect(out.significanceHint?.nA).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_SIGNIFICANCE);
    expect(out.significanceHint?.nB).toBeGreaterThanOrEqual(MIN_SAMPLES_FOR_SIGNIFICANCE);
    expect(out.significanceHint?.isSignificant).toBe(true);
  });

  it('phase 8: significanceHint stays null when one arm is too small', () => {
    const t0 = new Date();
    const runs = [
      ...Array.from({ length: 40 }, () => ({
        endedAt: t0,
        startedAt: t0,
        status: 'SUCCESS',
        templateVersion: 1,
      })),
      // Only 5 runs on v2 — under MIN_SAMPLES_FOR_SIGNIFICANCE.
      ...Array.from({ length: 5 }, () => ({
        endedAt: t0,
        startedAt: t0,
        status: 'SUCCESS',
        templateVersion: 2,
      })),
    ];
    const out = computeAnalytics(runs, [], 30);
    expect(out.significanceHint).toBeNull();
  });
});

describe('computeGlobalAnalytics', () => {
  it('rolls up runs across templates + ranks by traffic', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 1,
          endedAt: t0,
          startedAt: t0,
          status: 'SUCCESS',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 4,
          endedAt: t0,
          startedAt: t0,
          status: 'FAILED',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 2,
          endedAt: t0,
          startedAt: t0,
          status: 'SUCCESS',
          templateId: 'tplB',
          templateName: 'B',
        },
      ],
      30
    );
    expect(out.totalRuns).toBe(3);
    expect(out.succeeded).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.totalCost).toBe(7);
    expect(out.perTemplate).toHaveLength(2);
    expect(out.perTemplate[0]).toMatchObject({ templateId: 'tplA', totalCost: 5, totalRuns: 2 });
    expect(out.perTemplate[1]).toMatchObject({ templateId: 'tplB', totalCost: 2, totalRuns: 1 });
  });

  it('returns null successRate when nothing has finished', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: null,
          startedAt: t0,
          status: 'RUNNING',
          templateId: 'tplA',
          templateName: 'A',
        },
      ],
      30
    );
    expect(out.totalRuns).toBe(1);
    expect(out.successRate).toBeNull();
  });

  it('reports completedRuns and runningRuns split', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: null,
          startedAt: t0,
          status: 'RUNNING',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 0,
          endedAt: t0,
          startedAt: t0,
          status: 'SUCCESS',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 0,
          endedAt: t0,
          startedAt: t0,
          status: 'FAILED',
          templateId: 'tplA',
          templateName: 'A',
        },
      ],
      30
    );
    expect(out.totalRuns).toBe(3);
    expect(out.completedRuns).toBe(2);
    expect(out.runningRuns).toBe(1);
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);
  });

  it('success rate denominator is terminal/completed runs only', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: null,
          startedAt: t0,
          status: 'RUNNING',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 0,
          endedAt: null,
          startedAt: t0,
          status: 'PENDING',
          templateId: 'tplA',
          templateName: 'A',
        },
        {
          costUsdAccrued: 0,
          endedAt: t0,
          startedAt: t0,
          status: 'SUCCESS',
          templateId: 'tplA',
          templateName: 'A',
        },
      ],
      30
    );
    expect(out.totalRuns).toBe(3);
    expect(out.completedRuns).toBe(1);
    expect(out.successRate).toBe(1);
    expect(out.perTemplate[0]?.successRate).toBe(1);
  });

  it('exposes baseline sample size and suppresses vs-human when baseline is below threshold', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: t0,
          hasError: true,
          outcomeDomain: 'code',
          startedAt: t0,
          status: 'FAILED',
          templateId: 'tplA',
          templateName: 'A',
        },
      ],
      30,
      [{ domain: 'code', errorRate: 0.1, outcomeType: null, sampleSize: 5 }]
    );
    const domain = out.perDomain[0];
    expect(domain).toBeDefined();
    expect(domain?.baselineSampleSize).toBe(5);
    expect(domain?.humanErrorRate).toBeNull();
    expect(domain?.errorRateVsHuman).toBeNull();
  });

  it('surfaces human error rate and vs-human when baseline has enough samples', () => {
    const t0 = new Date();
    const out = computeGlobalAnalytics(
      [
        {
          costUsdAccrued: 0,
          endedAt: t0,
          hasError: true,
          outcomeDomain: 'code',
          startedAt: t0,
          status: 'FAILED',
          templateId: 'tplA',
          templateName: 'A',
        },
      ],
      30,
      [{ domain: 'code', errorRate: 0.1, outcomeType: null, sampleSize: 30 }]
    );
    const domain = out.perDomain[0];
    expect(domain).toBeDefined();
    expect(domain?.baselineSampleSize).toBe(30);
    expect(domain?.humanErrorRate).toBe(0.1);
    expect(domain?.agentErrorRate).toBe(1);
    expect(domain?.errorRateVsHuman).toBe(0.9);
  });
});

describe('GET /workflow-templates/analytics', () => {
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

  it('only marks results truncated when rows exceed the 10k cap', async () => {
    const makeRuns = (length: number) =>
      Array.from({ length }, (_, i) => ({
        costUsdAccrued: 0,
        endedAt: new Date(),
        hadHumanStep: false,
        hasError: false,
        id: `run-${i}`,
        outcomeDomain: 'code',
        outcomeType: null,
        startedAt: new Date(),
        status: 'SUCCESS',
        template: { id: 'tpl-cap', name: 'cap' },
        templateId: 'tpl-cap',
        wasAutonomous: true,
      })) as (typeof state.runs)[number][];

    state.runs = makeRuns(10_000);
    const exact = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates/analytics?window=30',
    });
    expect(exact.json().data.isTruncated).toBe(false);

    state.runs = makeRuns(10_001);
    const over = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'GET',
      url: '/api/v1/workflow-templates/analytics?window=30',
    });
    expect(over.statusCode).toBe(200);
    expect(over.json().data.totalRuns).toBe(10_000);
    expect(over.json().data.isTruncated).toBe(true);
  });
});

describe('workflow refinement (POST /:id/refine)', () => {
  let app: FastifyInstance;
  let state: Parameters<typeof buildApp>[0];

  beforeAll(async () => {
    state = { runs: [], templates: [], versions: new Map() };
    app = buildApp(state);
    await app.ready();
    // Seed one template (v1) to refine.
    await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: {
        name: 'refine-me',
        spec: VALID_SPEC,
        teamId: 'a1b2c3d4-1234-4567-89ab-cdef01234567',
      },
      url: '/api/v1/workflow-templates',
    });
  });

  afterAll(() => app.close());

  it('refines the latest version into a new version, pinning the template name', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected seeded template');
    }
    // The agent returns a refined spec that also tries to rename the workflow —
    // the route must ignore that rename and keep the template name stable.
    (state as { generatedSpec?: unknown }).generatedSpec = {
      ...VALID_SPEC,
      description: 'now with a lint step',
      name: 'model-picked-a-new-name',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'add a lint step before the terminate' },
      url: `/api/v1/workflow-templates/${tpl.id}/refine`,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.version).toBe(2);
    expect(body.summary).toBe('generated summary');
    expect(body.spec.name).toBe('refine-me'); // pinned, not the model's rename
  });

  it('returns 404 for an unknown template', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'x' },
      url: '/api/v1/workflow-templates/00000000-0000-4000-8000-0000000000ff/refine',
    });
    expect(res.statusCode).toBe(404);
  });

  it('maps an author failure to 422 (rephrase)', async () => {
    const tpl = state.templates[0];
    if (!tpl) {
      throw new Error('expected seeded template');
    }
    (state as { generateError?: boolean }).generateError = true;
    const res = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { prompt: 'do something impossible' },
      url: `/api/v1/workflow-templates/${tpl.id}/refine`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('REFINE_FAILED');
    (state as { generateError?: boolean }).generateError = false;
  });
});
