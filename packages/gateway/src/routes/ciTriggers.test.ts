import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gateState = vi.hoisted(() => ({ gate: undefined as unknown }));
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => gateState.gate),
}));

const launch = vi.hoisted(() => ({
  decision: { ok: true } as
    | { ok: true }
    | { ok: false; refusal: { status: 403; body: { error: { code: string; message: string } } } },
}));
vi.mock('../lib/launchAuthorization.js', () => ({
  authorizeLaunch: vi.fn(async () => launch.decision),
  sendLaunchRefusal: (
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    r: { status: number; body: unknown }
  ) => reply.status(r.status).send(r.body),
}));

import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { authorizeLaunch } from '../lib/launchAuthorization.js';
import { ciTriggerRoutes } from './ciTriggers.js';

const REPO = '11111111-1111-4111-8111-111111111111';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const URL = `/api/v1/repositories/${REPO}/ci-triggers`;
const AUTH = { authorization: 'Bearer fake' };

type Membership = { role: string; userId: string } | null;

function repoRow(owning: Membership, shared: Membership = null, isActive = true) {
  return {
    githubApiUrl: null,
    githubUrl: null,
    id: REPO,
    installation: null,
    isActive,
    organizationName: 'acme',
    repoName: 'api',
    shares: shared ? [{ team: { memberships: [shared] } }] : [],
    team: {
      memberships: owning ? [owning] : [],
      organization: { monthlyBudgetUsdCents: null },
      orgId: 'org-1',
    },
    teamId: 'team-1',
    type: 'git_repo',
  };
}

const VALID = {
  branchPatterns: ['main', 'release/*'],
  name: 'release branches',
};

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const auth = { role: 'ENGINEER', sub: 'user-1' };
  const prisma = {
    ciFailureTrigger: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: TRIGGER,
        ...data,
      })),
      delete: vi.fn(async () => ({})),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: TRIGGER,
        ...data,
      })),
    },
    ciFailureTriggerFire: { findMany: vi.fn(async (_args: { take?: number }) => [] as unknown[]) },
    configAuditLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
    connection: { findFirst: vi.fn() },
    workflowTemplate: {
      findFirst: vi.fn(),
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
    },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: auth.role, sub: auth.sub }),
  } as unknown as never);
  await app.register(ciTriggerRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  return { app, auth, prisma };
}

describe('ciTriggerRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.auth.role = 'ENGINEER';
    ctx.auth.sub = 'user-1';
    gateState.gate = undefined;
    launch.decision = { ok: true };
    vi.clearAllMocks();
    // The built-in template, unless a test says otherwise.
    ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(BUILTIN);
  });

  const BUILTIN = {
    activeVersion: 1,
    id: 'b0000000-0000-4000-8000-000000000000',
    inputSchema: CI_TRIAGE_INPUT_SCHEMA,
  };

  const lead = { role: 'LEAD', userId: 'user-1' };
  const member = { role: 'MEMBER', userId: 'user-1' };

  describe('reading', () => {
    it('lists the triggers to a member, saying whether they may manage them', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ canManage: false, triggers: [] });
    });

    it('lets a member of a SHARED team read, but not manage', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null, lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.json().data.canManage).toBe(false);
    });

    it('lists the templates a trigger may start with only the options a trigger sets', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      ctx.prisma.workflowTemplate.findMany.mockResolvedValue([
        {
          description: '',
          id: BUILTIN.id,
          inputSchema: CI_TRIAGE_INPUT_SCHEMA,
          name: 'ci',
          teamId: null,
        },
        { description: '', id: TEMPLATE, inputSchema: null, name: 'not-ci', teamId: null },
      ]);
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: `${URL}/templates` });
      expect(res.statusCode).toBe(200);
      const [only, ...rest] = res.json().data;
      expect(rest).toEqual([]);
      expect(only).toMatchObject({ builtIn: true, id: BUILTIN.id });
      expect(Object.keys(only.options.properties).sort()).toEqual([
        'commentOnPullRequest',
        'fixCategories',
        'maxCiFixAttempts',
        'minFixConfidence',
        'mode',
      ]);
      expect(JSON.stringify(ctx.prisma.workflowTemplate.findMany.mock.calls[0]?.[0])).toContain(
        'system:'
      );
    });

    it('404s a repository the caller is not a member of', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('creating', () => {
    it('lets a LEAD of the owning team create one, with safe defaults', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(201);
      expect(ctx.prisma.ciFailureTrigger.create.mock.calls[0]?.[0].data).toMatchObject({
        connectionId: REPO,
        createdById: 'user-1',
        events: ['push'],
        // No options: the template's defaults, which diagnose only.
        inputs: {},
        workflowPatterns: ['.github/workflows/**'],
      });
      expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('refuses a plain member and a shared team’s lead', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      let res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(403);
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null, lead));
      res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.ciFailureTrigger.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no branch patterns', { ...VALID, branchPatterns: [] }],
      ['only exclusions', { ...VALID, branchPatterns: ['!main'] }],
      ['an event that is never acted on', { ...VALID, events: ['pull_request_target'] }],
      ['an unknown mode', { ...VALID, inputs: { mode: 'AUTO_MERGE' } }],
      ['an option the template does not declare', { ...VALID, inputs: { autoMerge: true } }],
      ['a key the failing run fills', { ...VALID, inputs: { baseBranch: 'main' } }],
      ['a confidence floor out of range', { ...VALID, inputs: { minFixConfidence: 2 } }],
      ['no category to fix', { ...VALID, inputs: { fixCategories: [] } }],
      ['a negative cooldown', { ...VALID, cooldownMinutes: -1 }],
      ['a zero daily cap', { ...VALID, maxRunsPerDay: 0 }],
    ])('rejects %s', async (_label, payload) => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload, url: URL });
      expect(res.statusCode).toBe(400);
    });

    it('refuses a launch the access gate or the organization refuses', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      launch.decision = {
        ok: false,
        refusal: { body: { error: { code: 'REPO_ACCESS_DENIED', message: 'no' } }, status: 403 },
      };
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('REPO_ACCESS_DENIED');
      expect(ctx.prisma.ciFailureTrigger.create).not.toHaveBeenCalled();
      expect(vi.mocked(authorizeLaunch).mock.calls[0]?.[2]).toMatchObject({
        runIdentity: 'platform',
      });
    });

    it('requires a current GitHub permission under an enforcing gate', async () => {
      gateState.gate = { mode: 'enforce', staleAfterHours: 24 };
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.statusCode).toBe(404);
      const where = ctx.prisma.connection.findFirst.mock.calls[0]?.[0].where;
      expect(JSON.stringify(where)).toContain('repoAccess');
    });

    it('accepts a team template that takes the CI payload', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 2,
        id: TEMPLATE,
        inputSchema: CI_TRIAGE_INPUT_SCHEMA,
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { ...VALID, templateId: TEMPLATE },
        url: URL,
      });
      expect(res.statusCode).toBe(201);
      // System templates are excluded in the query itself.
      expect(
        JSON.stringify(ctx.prisma.workflowTemplate.findFirst.mock.calls[0]?.[0].where)
      ).toContain('system:');
    });

    it('refuses a template that does not take the CI payload', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 1,
        id: TEMPLATE,
        inputSchema: null,
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { ...VALID, templateId: TEMPLATE },
        url: URL,
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a template that is not active and global or the team's", async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        payload: { ...VALID, templateId: TEMPLATE },
        url: URL,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_TEMPLATE');
    });

    it('lets an ADMIN create one on any repository', async () => {
      ctx.auth.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('changing and removing', () => {
    it('updates and audits with before and after', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({
        id: TRIGGER,
        inputs: {},
        templateId: null,
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { inputs: { mode: 'fix' } },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.ciFailureTrigger.update.mock.calls[0]?.[0].data).toEqual({
        inputs: { mode: 'fix' },
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'UPDATE',
        entityType: 'CiFailureTrigger',
      });
    });

    it('lets a trigger be switched off without a launch decision, even on an inactive repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead, null, false));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({ enabled: true, id: TRIGGER });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { enabled: false },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(200);
      expect(authorizeLaunch).not.toHaveBeenCalled();
    });

    it('refuses turning a trigger on for an inactive repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead, null, false));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({ enabled: false, id: TRIGGER });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { enabled: true },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(409);
    });

    it('re-decides the launch when a change keeps the trigger able to start runs', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({
        id: TRIGGER,
        inputs: {},
        templateId: null,
      });
      launch.decision = {
        ok: false,
        refusal: { body: { error: { code: 'REPO_ACCESS_DENIED', message: 'no' } }, status: 403 },
      };
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { inputs: { mode: 'fix' } },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.ciFailureTrigger.update).not.toHaveBeenCalled();
    });

    it('checks the kept options against a new template', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({
        id: TRIGGER,
        inputs: { minFixConfidence: 0.8 },
        templateId: null,
      });
      // A CI-aware team template that declares no options.
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 1,
        id: TEMPLATE,
        inputSchema: {
          properties: {
            baseBranch: { type: 'string' },
            connectionId: { type: 'connection' },
            githubRunId: { type: 'string' },
            runAttempt: { type: 'number' },
          },
          required: ['githubRunId'],
          type: 'object',
        },
      });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { templateId: TEMPLATE },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUTS');
      expect(ctx.prisma.ciFailureTrigger.update).not.toHaveBeenCalled();
    });

    it('404s a trigger of another repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(404);
      expect(ctx.prisma.ciFailureTrigger.findFirst.mock.calls[0]?.[0].where).toMatchObject({
        connectionId: REPO,
        id: TRIGGER,
      });
    });

    it('refuses a member', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({ id: TRIGGER });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.ciFailureTrigger.delete).not.toHaveBeenCalled();
    });
  });

  it('shows a member what a trigger decided', async () => {
    ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
    ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({ id: TRIGGER });
    ctx.prisma.ciFailureTriggerFire.findMany.mockResolvedValue([
      { outcome: 'SUPPRESSED_COOLDOWN' },
    ] as never);
    const res = await ctx.app.inject({
      headers: AUTH,
      method: 'GET',
      url: `${URL}/${TRIGGER}/fires?limit=5`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.fires).toEqual([{ outcome: 'SUPPRESSED_COOLDOWN' }]);
    expect(ctx.prisma.ciFailureTriggerFire.findMany.mock.calls[0]?.[0].take).toBe(5);
  });
});
