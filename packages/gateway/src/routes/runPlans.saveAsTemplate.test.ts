import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanRoutes } from './runPlans.js';
import { workflowTemplateRoutes } from './workflowTemplates.js';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => false),
  resolveSettings: vi.fn(async () => ({})),
}));

const OWNER = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = '9f8e7d6c-2222-4222-8222-bbbbbbbbbbbb';
const TEAM = 'aaaaaaaa-3333-4333-8333-cccccccccccc';
const PLAN = '0b1c2d3e-0000-4000-8000-000000000001';
const tplId = (n: number) => `1c2d3e4f-0000-4000-8000-00000000000${n}`;
const TPL1 = tplId(1);

const SPEC = {
  description: 'A saved plan',
  entry: 'start',
  name: 'Plan spec name',
  nodes: { start: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: SPEC_SCHEMA_VERSION,
};

interface TemplateRow {
  id: string;
  name: string;
  teamId: string | null;
  status: string;
  activeVersion: number | null;
  isDefault: boolean;
  description: string;
  workspaceProvider: string | null;
  versions: Array<Record<string, unknown>>;
}

interface State {
  role: string;
  /** The caller's membership role in the plan's team; null = not a member. */
  teamRole: string | null;
  plans: Array<Record<string, unknown>>;
  templates: TemplateRow[];
  audit: Array<Record<string, unknown>>;
  leadLookups: Array<Record<string, unknown>>;
}

const futureDate = () => new Date(Date.now() + 3_600_000);

function planRow(over: Record<string, unknown> = {}) {
  return {
    expiresAt: futureDate(),
    id: PLAN,
    mode: 'delivering',
    ownerUserId: OWNER,
    scrubbedAt: null,
    spec: structuredClone(SPEC),
    status: 'PENDING',
    teamId: TEAM,
    ...over,
  };
}

describe('POST /run-plans/:id/save-as-template', () => {
  let app: FastifyInstance;
  let s: State;
  /** The caller's identity; the review tests switch it. */
  let caller = OWNER;

  beforeEach(async () => {
    caller = OWNER;
    s = {
      audit: [],
      leadLookups: [],
      plans: [planRow()],
      role: 'ENGINEER',
      teamRole: 'LEAD',
      templates: [],
    };
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: s.role, sub: caller }),
    } as unknown as never);
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-principal']) {
        (request as unknown as { principal: unknown }).principal = {
          scopes: [],
          servicePrincipalId: 'sp-1',
        };
      }
    });
    const prisma: Record<string, unknown> = {
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
      configAuditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          s.audit.push(data);
          return data;
        },
      },
      runPlan: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          s.plans.find((p) => p.id === where.id) ?? null,
      },
      teamMembership: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          s.leadLookups.push(args.where);
          return s.teamRole ? { role: s.teamRole } : null;
        },
        findUnique: async () => (s.teamRole ? { role: s.teamRole } : null),
      },
      workflowShellAudit: { createMany: async () => ({ count: 0 }) },
      workflowTemplate: {
        create: async ({
          data,
        }: {
          data: {
            activeVersion: number;
            description: string;
            name: string;
            status: string;
            teamId: string | null;
            versions: { create: Record<string, unknown> };
            workspaceProvider: string | null;
          };
        }) => {
          if (s.templates.some((t) => t.teamId === data.teamId && t.name === data.name)) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          const row: TemplateRow = {
            activeVersion: data.activeVersion,
            description: data.description,
            id: tplId(s.templates.length + 1),
            isDefault: false,
            name: data.name,
            status: data.status,
            teamId: data.teamId,
            versions: [
              { id: `ver-${s.templates.length + 1}`, version: 1, ...data.versions.create },
            ],
            workspaceProvider: data.workspaceProvider,
          };
          s.templates.push(row);
          return {
            ...row,
            _count: { versions: 1 },
            experimentSplit: null,
            experimentVersion: null,
            team: null,
          };
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          s.templates.find((t) => t.id === where.id) ?? null,
      },
      workflowTemplateVersion: {
        findUnique: async ({
          where,
        }: {
          where: { templateId_version: { templateId: string; version: number } };
        }) => {
          const t = s.templates.find((x) => x.id === where.templateId_version.templateId);
          const v = t?.versions.find((x) => x.version === where.templateId_version.version);
          return v ? { ...v, reviewedAt: null, reviewedBy: null, spec: v.spec } : null;
        },
      },
    };
    app.decorate('prisma', prisma as never);
    app.decorateRequest('repoAccessGate', null as never);
    await app.register(runPlanRoutes, { prefix: '/api/v1/run-plans' });
    await app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const save = (payload: unknown = {}, headers: Record<string, string> = {}) =>
    app.inject({
      headers: { authorization: 'Bearer x', ...headers },
      method: 'POST',
      payload: payload as never,
      url: `/api/v1/run-plans/${PLAN}/save-as-template`,
    });

  it('saves the stored spec as a DRAFT in the plan team, generated by the owner', async () => {
    const res = await save({});
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toEqual({
      name: 'Plan spec name',
      status: 'DRAFT',
      templateId: TPL1,
      version: 1,
    });
    const tpl = s.templates[0] as TemplateRow;
    expect(tpl).toMatchObject({
      isDefault: false,
      status: 'DRAFT',
      teamId: TEAM,
      workspaceProvider: 'git_repo',
    });
    expect(tpl.versions[0]).toMatchObject({ createdBy: OWNER, generatedBy: 'run_plan' });
    // The stored spec, not anything the client sent.
    expect((tpl.versions[0] as { spec: { entry: string } }).spec.entry).toBe('start');
  });

  it('uses the requested name for the template and its spec, and gives output-only plans the same git_repo provider', async () => {
    s.plans = [planRow({ mode: 'output-only' })];
    const res = await save({ name: 'My template' });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe('My template');
    const tpl = s.templates[0] as TemplateRow;
    expect((tpl.versions[0] as { spec: { name: string } }).spec.name).toBe('My template');
    expect(tpl.workspaceProvider).toBe('git_repo');
  });

  it('refuses a body that names a team or anything else', async () => {
    expect((await save({ teamId: TEAM })).statusCode).toBe(400);
    expect((await save({ name: '' })).statusCode).toBe(400);
    expect((await save({ name: 'x'.repeat(121) })).statusCode).toBe(400);
    expect(s.templates).toHaveLength(0);
  });

  it('answers 404 to anyone but the owner, and to a missing plan', async () => {
    caller = OTHER;
    expect((await save({})).statusCode).toBe(404);
    caller = OWNER;
    s.plans = [];
    const res = await save({});
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PLAN_NOT_FOUND');
    expect(s.templates).toHaveLength(0);
  });

  it('refuses a service principal', async () => {
    const res = await save({}, { 'x-test-principal': '1' });
    expect(res.statusCode).toBe(403);
    expect(s.templates).toHaveLength(0);
  });

  it('refuses a caller below LEAD on the plan team, and lets a platform ADMIN through', async () => {
    s.teamRole = null;
    const res = await save({});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(s.templates).toHaveLength(0);
    // The lookup is the template-authoring one: LEAD or ADMIN of the plan's team.
    expect(s.leadLookups[0]).toMatchObject({ role: { in: ['LEAD', 'ADMIN'] }, teamId: TEAM });
    s.role = 'ADMIN';
    expect((await save({})).statusCode).toBe(201);
  });

  it('refuses a scrubbed plan with PLAN_SCRUBBED', async () => {
    s.plans = [planRow({ scrubbedAt: new Date(), status: 'LAUNCHED' })];
    const res = await save({});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PLAN_SCRUBBED');
  });

  it.each(['REJECTED', 'EXPIRED'])('refuses a %s plan with PLAN_NOT_SAVEABLE', async (status) => {
    s.plans = [planRow({ status })];
    const res = await save({});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PLAN_NOT_SAVEABLE');
  });

  it('treats a pending plan past its expiry as expired', async () => {
    s.plans = [planRow({ expiresAt: new Date(Date.now() - 1000) })];
    expect((await save({})).json().error.code).toBe('PLAN_NOT_SAVEABLE');
  });

  it.each(['PENDING', 'APPROVED', 'LAUNCHED'])('saves a %s plan', async (status) => {
    s.plans = [planRow({ status })];
    expect((await save({})).statusCode).toBe(201);
  });

  it('answers 409 NAME_CONFLICT for a name the team already uses, and never renames', async () => {
    expect((await save({ name: 'Taken' })).statusCode).toBe(201);
    const res = await save({ name: 'Taken' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NAME_CONFLICT');
    expect(res.json().error.message).toMatch(/Taken/);
    expect(s.templates).toHaveLength(1);
  });

  it('refuses the reserved system template name', async () => {
    const res = await save({ name: 'Planned Run' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESERVED_TEMPLATE_NAME');
  });

  it('answers the same INVALID_SPEC a normal save does for a spec that no longer parses', async () => {
    s.plans = [planRow({ spec: { ...SPEC, schemaVersion: SPEC_SCHEMA_VERSION + 99 } })];
    const res = await save({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SPEC');
    expect(s.templates).toHaveLength(0);
  });

  it('writes an ids-only run_plan.saved_as_template audit entry', async () => {
    await save({});
    const entry = s.audit.find(
      (a) => (a.afterJson as { event?: string })?.event === 'run_plan.saved_as_template'
    );
    expect(entry).toMatchObject({
      action: 'CREATE',
      actorId: OWNER,
      entityId: PLAN,
      entityType: 'RunPlan',
    });
    expect(entry?.afterJson).toEqual({
      event: 'run_plan.saved_as_template',
      teamId: TEAM,
      templateId: TPL1,
    });
    // The template's own creation is on record too, tied to the plan by id.
    expect(
      s.audit.find((a) => a.entityType === 'WorkflowTemplate' && a.entityId === TPL1)
    ).toBeTruthy();
  });

  it('leaves the saved draft unreviewable by its owner and unpromotable until someone else reviews it', async () => {
    await save({});
    const review = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      url: `/api/v1/workflow-templates/${TPL1}/versions/1/review`,
    });
    expect(review.statusCode).toBe(403);
    expect(review.json().error.code).toBe('SELF_REVIEW_FORBIDDEN');
    const promote = await app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      payload: { version: 1 },
      url: `/api/v1/workflow-templates/${TPL1}/promote`,
    });
    expect(promote.statusCode).toBe(409);
    expect(promote.json().error.code).toBe('REVIEW_REQUIRED');
  });
});
