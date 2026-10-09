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
const settings = vi.hoisted(() => ({ pushAllowed: false }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) =>
    key === 'github.ciFixPushToPullRequestEnabled' ? settings.pushAllowed : undefined
  ),
}));

vi.mock('../lib/launchAuthorization.js', () => ({
  authorizeLaunch: vi.fn(async () => launch.decision),
  sendLaunchRefusal: (
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    r: { status: number; body: unknown }
  ) => reply.status(r.status).send(r.body),
}));

import { WORKFLOW_RUN_FAILED } from '@auto-swe/shared/automation';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { authorizeLaunch } from '../lib/launchAuthorization.js';
import { automationRoutes } from './automations.js';

const REPO = '11111111-1111-4111-8111-111111111111';
const AUTOMATION = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const URL = '/api/v1/automations/events';
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

const FILTERS = {
  branchPatterns: ['main', 'release/*'],
  events: ['push'],
  workflowPatterns: ['.github/workflows/**'],
};

const VALID = {
  connectionId: REPO,
  filters: FILTERS,
  name: 'release branches',
  source: WORKFLOW_RUN_FAILED,
};

/** A stored automation, as `findUnique` returns it. */
const stored = (over: Record<string, unknown> = {}) => ({
  connectionId: REPO,
  enabled: true,
  filters: FILTERS,
  id: AUTOMATION,
  inputs: {},
  source: WORKFLOW_RUN_FAILED,
  templateId: null,
  ...over,
});

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const auth = { role: 'ENGINEER', sub: 'user-1' };
  const prisma = {
    automation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: AUTOMATION,
        ...data,
      })),
      delete: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: AUTOMATION,
        ...data,
      })),
    },
    automationFire: { findMany: vi.fn(async (_args: { take?: number }) => [] as unknown[]) },
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
  await app.register(automationRoutes, { prefix: '/api/v1/automations' });
  await app.ready();
  return { app, auth, prisma };
}

describe('automationRoutes (event automations)', () => {
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
    settings.pushAllowed = false;
    vi.clearAllMocks();
    // The built-in template, unless a test says otherwise.
    ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(BUILTIN);
    ctx.prisma.automation.findUnique.mockResolvedValue(stored());
  });

  const BUILTIN = {
    activeVersion: 1,
    id: 'b0000000-0000-4000-8000-000000000000',
    inputSchema: CI_TRIAGE_INPUT_SCHEMA,
  };

  const lead = { role: 'LEAD', userId: 'user-1' };
  const member = { role: 'MEMBER', userId: 'user-1' };
  const post = (payload: Record<string, unknown>) =>
    ctx.app.inject({ headers: AUTH, method: 'POST', payload, url: URL });
  const patch = (payload: Record<string, unknown>) =>
    ctx.app.inject({ headers: AUTH, method: 'PATCH', payload, url: `${URL}/${AUTOMATION}` });

  describe('reading', () => {
    it('lists a repository’s automations to a member, saying whether they may manage them', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}?connectionId=${REPO}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ automations: [], canManage: false });
    });

    it('lets a member of a SHARED team read, but not manage', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null, lead));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}?connectionId=${REPO}`,
      });
      expect(res.json().data.canManage).toBe(false);
    });

    it('lists the templates a source may start, with only the options an automation sets', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findMany.mockResolvedValue([
        { description: '', id: BUILTIN.id, inputSchema: CI_TRIAGE_INPUT_SCHEMA, name: 'ci' },
        { description: '', id: TEMPLATE, inputSchema: null, name: 'not-ci' },
      ]);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}/templates?connectionId=${REPO}&source=${WORKFLOW_RUN_FAILED}`,
      });
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
        'pullRequestDelivery',
      ]);
      expect(JSON.stringify(ctx.prisma.workflowTemplate.findMany.mock.calls[0]?.[0])).toContain(
        'system:'
      );
    });

    it('refuses the template list to those who may not manage', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null, lead));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}/templates?connectionId=${REPO}&source=${WORKFLOW_RUN_FAILED}`,
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.workflowTemplate.findMany).not.toHaveBeenCalled();
    });

    it('404s a repository the caller is not a member of', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}?connectionId=${REPO}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('requires a current GitHub permission under an enforcing gate', async () => {
      gateState.gate = { mode: 'enforce', staleAfterHours: 24 };
      ctx.prisma.connection.findFirst.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}?connectionId=${REPO}`,
      });
      expect(res.statusCode).toBe(404);
      const where = ctx.prisma.connection.findFirst.mock.calls[0]?.[0].where;
      expect(JSON.stringify(where)).toContain('repoAccess');
    });

    it('shows a member what an automation decided', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      ctx.prisma.automationFire.findMany.mockResolvedValue([
        { outcome: 'SUPPRESSED_COOLDOWN' },
      ] as never);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}/${AUTOMATION}/fires?limit=5`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.fires).toEqual([{ outcome: 'SUPPRESSED_COOLDOWN' }]);
      expect(ctx.prisma.automationFire.findMany.mock.calls[0]?.[0].take).toBe(5);
    });

    it('404s an automation on a repository the caller cannot see', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'GET',
        url: `${URL}/${AUTOMATION}/fires`,
      });
      expect(res.statusCode).toBe(404);
      expect(ctx.prisma.automationFire.findMany).not.toHaveBeenCalled();
    });
  });

  describe('creating', () => {
    it('lets a LEAD of the owning team create one, with safe defaults', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await post(VALID);
      expect(res.statusCode).toBe(201);
      expect(ctx.prisma.automation.create.mock.calls[0]?.[0].data).toMatchObject({
        connectionId: REPO,
        createdById: 'user-1',
        filters: FILTERS,
        // No options: the template's defaults, which diagnose only.
        inputs: {},
        source: WORKFLOW_RUN_FAILED,
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'CREATE',
        entityType: 'Automation',
      });
    });

    it('refuses a plain member and a shared team’s lead', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      expect((await post(VALID)).statusCode).toBe(403);
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null, lead));
      expect((await post(VALID)).statusCode).toBe(403);
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no branch patterns', { ...VALID, filters: { ...FILTERS, branchPatterns: [] } }],
      ['only exclusions', { ...VALID, filters: { ...FILTERS, branchPatterns: ['!main'] } }],
      [
        'an event that is never acted on',
        { ...VALID, filters: { ...FILTERS, events: ['pull_request_target'] } },
      ],
      ['an unknown source', { ...VALID, source: 'github.push' }],
      ['an unknown mode', { ...VALID, inputs: { mode: 'AUTO_MERGE' } }],
      ['an option the template does not declare', { ...VALID, inputs: { autoMerge: true } }],
      ['a key the occurrence fills', { ...VALID, inputs: { baseBranch: 'main' } }],
      ['a null option', { ...VALID, inputs: { mode: null } }],
      ['a confidence floor out of range', { ...VALID, inputs: { minFixConfidence: 2 } }],
      ['no category to fix', { ...VALID, inputs: { fixCategories: [] } }],
      ['a negative cooldown', { ...VALID, cooldownMinutes: -1 }],
      ['a zero daily cap', { ...VALID, maxRunsPerDay: 0 }],
    ])('rejects %s', async (_label, payload) => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('refuses a launch the access gate or the organization refuses', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      launch.decision = {
        ok: false,
        refusal: { body: { error: { code: 'REPO_ACCESS_DENIED', message: 'no' } }, status: 403 },
      };
      const res = await post(VALID);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('REPO_ACCESS_DENIED');
      expect(vi.mocked(authorizeLaunch).mock.calls[0]?.[2]).toMatchObject({
        runIdentity: 'platform',
      });
    });

    it('accepts a team template its source can start', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 2,
        id: TEMPLATE,
        inputSchema: CI_TRIAGE_INPUT_SCHEMA,
      });
      const res = await post({ ...VALID, templateId: TEMPLATE });
      expect(res.statusCode).toBe(201);
      expect(
        JSON.stringify(ctx.prisma.workflowTemplate.findFirst.mock.calls[0]?.[0].where)
      ).toContain('system:');
    });

    it.each([
      ['takes no CI payload', { activeVersion: 1, id: TEMPLATE, inputSchema: null }],
      ['is not active and global or the team’s', null],
    ])('refuses a template that %s', async (_label, row) => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(row);
      const res = await post({ ...VALID, templateId: TEMPLATE });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_TEMPLATE');
    });

    it('refuses a push delivery an admin has not allowed, or with a team template', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const payload = { ...VALID, inputs: { mode: 'fix', pullRequestDelivery: 'push' } };
      let res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OPTION_DISABLED');
      settings.pushAllowed = true;
      expect((await post(payload)).statusCode).toBe(201);
      res = await post({ ...payload, templateId: TEMPLATE });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/default template/);
    });

    it('checks a template requiring a pull request against push failures too', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 1,
        id: TEMPLATE,
        inputSchema: {
          ...CI_TRIAGE_INPUT_SCHEMA,
          required: [...(CI_TRIAGE_INPUT_SCHEMA.required ?? []), 'pullRequestNumber'],
        },
      });
      const prOnly = { ...FILTERS, events: ['pull_request'] };
      expect((await post({ ...VALID, filters: prOnly, templateId: TEMPLATE })).statusCode).toBe(
        201
      );
      const withPush = await post({
        ...VALID,
        filters: { ...FILTERS, events: ['push', 'pull_request'] },
        templateId: TEMPLATE,
      });
      expect(withPush.statusCode).toBe(400);
      expect(withPush.json().error.code).toBe('INVALID_INPUTS');
    });

    it('lets an ADMIN create one on any repository', async () => {
      ctx.auth.role = 'ADMIN';
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(null));
      expect((await post(VALID)).statusCode).toBe(201);
    });
  });

  describe('changing and removing', () => {
    it('updates and audits with before and after', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await patch({ inputs: { mode: 'fix' } });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.automation.update.mock.calls[0]?.[0].data).toEqual({
        inputs: { mode: 'fix' },
      });
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'UPDATE',
        entityType: 'Automation',
      });
    });

    it('lets an automation be switched off without a launch decision, even on an inactive repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead, null, false));
      expect((await patch({ enabled: false })).statusCode).toBe(200);
      expect(authorizeLaunch).not.toHaveBeenCalled();
    });

    it('lets one that stays off be edited without a launch decision', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead, null, false));
      ctx.prisma.automation.findUnique.mockResolvedValue(stored({ enabled: false }));
      expect((await patch({ name: 'renamed' })).statusCode).toBe(200);
      expect(authorizeLaunch).not.toHaveBeenCalled();
    });

    it('refuses turning one on for an inactive repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead, null, false));
      ctx.prisma.automation.findUnique.mockResolvedValue(stored({ enabled: false }));
      expect((await patch({ enabled: true })).statusCode).toBe(409);
    });

    it('re-decides the launch when a change keeps it able to start runs', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      launch.decision = {
        ok: false,
        refusal: { body: { error: { code: 'REPO_ACCESS_DENIED', message: 'no' } }, status: 403 },
      };
      expect((await patch({ inputs: { mode: 'fix' } })).statusCode).toBe(403);
      expect(ctx.prisma.automation.update).not.toHaveBeenCalled();
    });

    it('checks the kept options against a new template', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.automation.findUnique.mockResolvedValue(
        stored({ inputs: { minFixConfidence: 0.8 } })
      );
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
      const res = await patch({ templateId: TEMPLATE });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUTS');
      expect(ctx.prisma.automation.update).not.toHaveBeenCalled();
    });

    it('checks new filters, and stores them as the source parsed them', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      expect((await patch({ filters: { ...FILTERS, events: [] } })).statusCode).toBe(400);
      const res = await patch({ filters: { ...FILTERS, events: ['push', 'push'] } });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.automation.update.mock.calls[0]?.[0].data.filters).toEqual(FILTERS);
    });

    it('404s an unknown automation', async () => {
      ctx.prisma.automation.findUnique.mockResolvedValue(null);
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${AUTOMATION}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses a member', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${AUTOMATION}`,
      });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.automation.delete).not.toHaveBeenCalled();
    });

    it('deletes for a lead, and audits it', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${AUTOMATION}`,
      });
      expect(res.statusCode).toBe(204);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'DELETE',
        entityType: 'Automation',
      });
    });
  });
});
