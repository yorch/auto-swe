import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
const settings = vi.hoisted(() => ({
  jiraPolling: true,
  jiraProjects: ['PAY'] as string[],
  otherPrsAllowed: false,
  pushAllowed: false,
  signingPolicyTeams: [] as string[],
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string, ctx?: { teamId?: string }) =>
    key === 'workflow.jiraPollAutomationsEnabled'
      ? settings.jiraPolling
      : key === 'workflow.jiraPollProjectKeys'
        ? settings.jiraProjects
        : key === 'github.ciFixPushToPullRequestEnabled'
          ? settings.pushAllowed
          : key === 'github.prFeedbackOtherPullRequestsEnabled'
            ? settings.otherPrsAllowed
            : key === 'workflow.templateWebhookRequireSignature'
              ? settings.signingPolicyTeams.includes(ctx?.teamId ?? '')
              : undefined
  ),
}));

const tracker = vi.hoisted(() => ({
  config: { webhookSecret: 's', webhookTriggerStatus: 'Ready for dev' } as Record<string, unknown>,
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveIssueTrackerConfig: vi.fn(async () => tracker.config),
}));

const jira = vi.hoisted(() => ({
  searchIssues: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/integrations/registry', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/integrations/registry')>()),
  // Like the real one: no client without a provider and a token.
  createIssueTrackerProvider: vi.fn((config: { provider?: string; apiToken?: string | null }) =>
    config.provider && config.apiToken ? { searchIssues: jira.searchIssues } : null
  ),
}));

const engine = vi.hoisted(() => ({ decideAndStart: vi.fn() }));
vi.mock('../lib/automations/engine.js', async (orig) => ({
  ...(await orig<typeof import('../lib/automations/engine.js')>()),
  decideAndStart: engine.decideAndStart,
}));

vi.mock('../lib/launchAuthorization.js', () => ({
  authorizeLaunch: vi.fn(async () => launch.decision),
  sendLaunchRefusal: (
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    r: { status: number; body: unknown }
  ) => reply.status(r.status).send(r.body),
}));

import {
  JIRA_FILTER_NEW_ISSUE,
  PR_FEEDBACK,
  WORKFLOW_RUN_FAILED,
} from '@auto-swe/shared/automation';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { AtlassianError } from '@auto-swe/shared/lib/integrations/atlassianClient';
import { createIssueTrackerProvider } from '@auto-swe/shared/lib/integrations/registry';
import { PR_FEEDBACK_INPUT_SCHEMA } from '@auto-swe/shared/lib/prFeedback';
import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
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
    automationFire: {
      findFirst: vi.fn(),
      findMany: vi.fn(async (_args: { take?: number }) => [] as unknown[]),
      groupBy: vi.fn(async (_args: unknown) => [] as unknown[]),
    },
    automationPollState: { updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })) },
    configAuditLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
    connection: {
      findFirst: vi.fn(),
      // The declared-connection check at save: nothing answers for an id, which is the refusal.
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
    },
    workflowRun: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
      groupBy: vi.fn(async (_args: unknown) => [] as unknown[]),
    },
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
    settings.otherPrsAllowed = false;
    settings.pushAllowed = false;
    vi.clearAllMocks();
    // The built-in template, unless a test says otherwise.
    ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(BUILTIN);
    ctx.prisma.automation.findUnique.mockResolvedValue(stored());
    ctx.prisma.automation.findMany.mockResolvedValue([]);
    ctx.prisma.workflowTemplate.findMany.mockResolvedValue([]);
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

  describe('retrying a decision', () => {
    const FIRE = '44444444-4444-4444-8444-444444444444';
    const FACTS = {
      branch: 'main',
      event: 'push',
      headSha: 'a'.repeat(40),
      pullRequestNumber: null,
      runAttempt: 1,
      runId: '12',
      workflowPath: '.github/workflows/ci.yml',
    };
    const fire = (over: Record<string, unknown> = {}) => ({
      facts: FACTS,
      id: FIRE,
      outcome: 'FAILED_TO_START',
      ownerKey: 'github.com/acme/api',
      retriedAt: null,
      ...over,
    });
    const retry = () =>
      ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `${URL}/${AUTOMATION}/fires/${FIRE}/retry`,
      });

    it('lets a lead take a decision that started nothing again, through every limit', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.automationFire.findFirst.mockResolvedValue(fire());
      engine.decideAndStart.mockResolvedValue({ automationId: AUTOMATION, outcome: 'STARTED' });
      const res = await retry();
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ outcome: 'STARTED' });
      expect(engine.decideAndStart.mock.calls[0]?.[2]).toMatchObject({
        facts: FACTS,
        ownerKey: 'github.com/acme/api',
        retry: { fireId: FIRE, kind: 'manual' },
      });
      expect(authorizeLaunch).toHaveBeenCalled();
    });

    it('refuses a plain member', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(member));
      ctx.prisma.automationFire.findFirst.mockResolvedValue(fire());
      expect((await retry()).statusCode).toBe(403);
      expect(engine.decideAndStart).not.toHaveBeenCalled();
    });

    it.each([
      ['a decision that started a run', fire({ outcome: 'STARTED' }), stored()],
      ['a decision already taken again', fire({ retriedAt: new Date() }), stored()],
      ['an occurrence this build cannot read', fire({ facts: { runId: 'x' } }), stored()],
      ['an automation that is off', fire(), stored({ enabled: false })],
      [
        'filters that no longer select it',
        fire(),
        stored({ filters: { ...FILTERS, branchPatterns: ['release/*'] } }),
      ],
    ])('refuses %s', async (_name, row, automation) => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.automation.findUnique.mockResolvedValue(automation);
      ctx.prisma.automationFire.findFirst.mockResolvedValue(row);
      const res = await retry();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('NOT_RETRYABLE');
      expect(engine.decideAndStart).not.toHaveBeenCalled();
    });

    it('refuses a decision recorded for an owner that is not a repository', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.automationFire.findFirst.mockResolvedValue(fire({ ownerKey: '@team/t1' }));
      const res = await retry();
      expect(res.statusCode).toBe(409);
      expect(engine.decideAndStart).not.toHaveBeenCalled();
    });

    it('answers 409 when another retry got there first', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.automationFire.findFirst.mockResolvedValue(fire());
      engine.decideAndStart.mockResolvedValue({ duplicate: true });
      expect((await retry()).statusCode).toBe(409);
    });
  });

  describe('the list of every kind', () => {
    const listed = (role: string | null) => ({
      ...stored(),
      connection: {
        id: REPO,
        organizationName: 'acme',
        repoName: 'api',
        team: { id: 'team-1', memberships: role ? [{ role }] : [], name: 'Payments' },
      },
      createdAt: new Date(0),
      name: 'mainline',
      template: null,
    });
    const list = () => ctx.app.inject({ headers: AUTH, method: 'GET', url: '/api/v1/automations' });

    it('lists event automations on reachable repositories, with who may manage each', async () => {
      ctx.prisma.automation.findMany.mockResolvedValue([
        listed('LEAD'),
        { ...listed(null), id: 'x' },
      ] as never);
      // The newest decision per automation: a groupBy, then just those rows.
      ctx.prisma.automationFire.groupBy.mockResolvedValue([
        { _max: { createdAt: new Date(1000) }, automationId: AUTOMATION },
      ]);
      ctx.prisma.automationFire.findMany.mockResolvedValue([
        { automationId: AUTOMATION, createdAt: new Date(1000), outcome: 'STARTED' },
        { automationId: AUTOMATION, createdAt: new Date(1000), outcome: 'SUPPRESSED_COOLDOWN' },
      ]);
      const res = await list();
      expect(res.statusCode).toBe(200);
      const [lead, plain] = res.json().data;
      expect(lead).toMatchObject({
        canManage: true,
        kind: 'event',
        lastActivity: { outcome: 'STARTED' },
        repository: { id: REPO },
        when: expect.stringContaining('When CI fails'),
      });
      expect(plain).toMatchObject({ canManage: false, lastActivity: null });
      expect(ctx.prisma.automationFire.findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
      expect(
        JSON.stringify((ctx.prisma.automation.findMany.mock.calls as unknown[][])[0]?.[0])
      ).toContain('memberships');
    });

    it('lists template webhooks the caller can read, editable only where they may write', async () => {
      ctx.prisma.workflowTemplate.findMany
        .mockResolvedValueOnce([
          { id: TEMPLATE, name: 'hooked', status: 'ACTIVE', team: { id: 't', name: 'T' } },
        ])
        .mockResolvedValueOnce([]);
      const [hook] = (await list()).json().data;
      expect(hook).toMatchObject({ canManage: false, id: TEMPLATE, kind: 'template_webhook' });
    });

    it('says whether each webhook is signed and whether signatures are required', async () => {
      settings.signingPolicyTeams = ['t-policy'];
      const hook = (id: string, teamId: string, extra: Record<string, unknown>) => ({
        id,
        name: id,
        status: 'ACTIVE',
        team: { id: teamId, name: teamId, orgId: null },
        teamId,
        webhookRequireSignature: false,
        webhookSigningSecretKeyVersion: null,
        ...extra,
      });
      ctx.prisma.workflowTemplate.findMany
        .mockResolvedValueOnce([
          hook('unsigned', 't', {}),
          hook('optional', 't', { webhookSigningSecretKeyVersion: 1 }),
          hook('required', 't', {
            webhookRequireSignature: true,
            webhookSigningSecretKeyVersion: 1,
          }),
          hook('policy', 't-policy', {}),
        ])
        .mockResolvedValueOnce([]);
      const rows = (await list()).json().data as Array<Record<string, unknown>>;
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId.unsigned).toMatchObject({ signatureRequired: false, signed: false });
      expect(byId.optional).toMatchObject({ signatureRequired: false, signed: true });
      expect(byId.required).toMatchObject({ signatureRequired: true, signed: true });
      expect(byId.policy).toMatchObject({ signatureRequired: true, signed: false });
      // The secret is never selected, only whether one exists.
      const select = JSON.stringify(ctx.prisma.workflowTemplate.findMany.mock.calls[0]?.[0]);
      expect(select).not.toContain('Ciphertext');
      settings.signingPolicyTeams = [];
    });

    it('needs platform role LEAD as well as write access to manage a webhook', async () => {
      const hooked = [
        { id: TEMPLATE, name: 'hooked', status: 'ACTIVE', team: { id: 't', name: 'T' } },
      ];
      ctx.prisma.workflowTemplate.findMany
        .mockResolvedValueOnce(hooked)
        .mockResolvedValueOnce([{ id: TEMPLATE }]);
      expect((await list()).json().data[0].canManage).toBe(false);
      ctx.auth.role = 'LEAD';
      ctx.prisma.workflowTemplate.findMany
        .mockResolvedValueOnce(hooked)
        .mockResolvedValueOnce([{ id: TEMPLATE }]);
      expect((await list()).json().data[0].canManage).toBe(true);
    });

    it('reports a webhook’s last call from the ledger, only calls the caller may see', async () => {
      ctx.prisma.workflowTemplate.findMany
        .mockResolvedValueOnce([
          { id: TEMPLATE, name: 'hooked', status: 'ACTIVE', team: { id: 't', name: 'T' } },
        ])
        .mockResolvedValueOnce([]);
      const calls = (where: unknown) => JSON.stringify(where).includes('template_webhook.call');
      ctx.prisma.automationFire.groupBy.mockImplementation((async (args: { where: unknown }) =>
        calls(args.where)
          ? [{ _max: { createdAt: new Date(5000) }, subjectKey: TEMPLATE }]
          : []) as never);
      ctx.prisma.automationFire.findMany.mockImplementation((async (args: { where: unknown }) =>
        calls(args.where)
          ? [
              {
                createdAt: new Date(5000),
                outcome: 'FAILED_TO_START',
                reason: 'the payload does not fit the template’s inputs',
                subjectKey: TEMPLATE,
              },
            ]
          : []) as never);
      const [hook] = (await list()).json().data;
      expect(hook.lastActivity).toMatchObject({
        outcome: 'FAILED_TO_START',
        reason: expect.stringMatching(/payload/),
      });
      const where = JSON.stringify(
        (ctx.prisma.automationFire.groupBy.mock.calls as unknown[][]).find((c) =>
          calls((c[0] as { where: unknown }).where)
        )?.[0]
      );
      // The non-admin reach predicate names the caller; a call on no repository only for a
      // team's own template.
      expect(where).toContain('user-1');
      expect(where).toContain('"connectionId":null');
    });

    it('never reads the tracker configuration for anyone but an admin', async () => {
      const data = (await list()).json().data;
      expect(data.some((r: { kind: string }) => r.kind === 'tracker_transition')).toBe(false);
      expect(resolveIssueTrackerConfig).not.toHaveBeenCalled();
      ctx.auth.role = 'ADMIN';
      const admin = (await list()).json().data;
      expect(admin).toEqual([
        expect.objectContaining({
          kind: 'tracker_transition',
          when: expect.stringContaining('Ready for dev'),
        }),
      ]);
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

    it('refuses an option naming a connection the team cannot use', async () => {
      // The same decision the fire takes, taken here so the author is told when they save rather
      // than from a run that never started. The lookup answers for no id, so the option names no
      // connection the team can use.
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 2,
        id: TEMPLATE,
        inputSchema: {
          ...CI_TRIAGE_INPUT_SCHEMA,
          properties: {
            ...CI_TRIAGE_INPUT_SCHEMA.properties,
            docConnectionId: { type: 'connection' },
          },
        },
      });

      const res = await post({
        ...VALID,
        inputs: { docConnectionId: 'cccccccc-0000-4000-8000-000000000003' },
        templateId: TEMPLATE,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUTS');
      expect(res.json().error.message).toMatch(/not one this team can use/);
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

    it('refuses a pull-request filter value an admin has not allowed', async () => {
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue({
        activeVersion: 1,
        id: BUILTIN.id,
        inputSchema: PR_FEEDBACK_INPUT_SCHEMA,
      });
      const payload = {
        ...VALID,
        filters: { pullRequests: ['platform', 'others'], triggers: ['command'] },
        source: PR_FEEDBACK,
      };
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OPTION_DISABLED');
      // The setting is checked for the repository's team, as a gated option's is.
      settings.otherPrsAllowed = true;
      expect((await post(payload)).statusCode).toBe(201);
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

  describe('Jira filter automations', () => {
    const JIRA_TEMPLATE = {
      activeVersion: 1,
      id: 'c0000000-0000-4000-8000-000000000000',
      inputSchema: {
        properties: {
          connectionId: { connectionType: 'git_repo', type: 'connection' },
          description: { type: 'string' },
          ticketId: { type: 'string' },
        },
        required: ['connectionId', 'description', 'ticketId'],
        type: 'object',
      },
    };
    const JIRA = {
      connectionId: REPO,
      filters: { jql: 'status = "To Do"' },
      name: 'new tickets',
      source: JIRA_FILTER_NEW_ISSUE,
    };
    const storedJira = (over: Record<string, unknown> = {}) =>
      stored({ filters: JIRA.filters, source: JIRA_FILTER_NEW_ISSUE, ...over });
    const originalConfig = tracker.config;

    beforeEach(() => {
      settings.jiraPolling = true;
      settings.jiraProjects = ['PAY'];
      tracker.config = {
        allowPrivateNetwork: false,
        apiToken: 't',
        baseUrl: 'https://acme.atlassian.net',
        email: 'e@acme.test',
        provider: 'jira',
      };
      jira.searchIssues.mockResolvedValue({ issues: [], truncated: false });
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(JIRA_TEMPLATE);
      ctx.prisma.connection.findFirst.mockResolvedValue(repoRow(lead));
    });
    afterEach(() => {
      tracker.config = originalConfig;
    });

    it('creates one after asking Jira to run the JQL once, narrowed to the allowed projects', async () => {
      const res = await post(JIRA);
      expect(res.statusCode).toBe(201);
      expect(jira.searchIssues).toHaveBeenCalledTimes(1);
      expect(jira.searchIssues).toHaveBeenCalledWith('project in ("PAY") AND (status = "To Do")', {
        maxResults: 1,
      });
      expect(ctx.prisma.automation.create.mock.calls[0]?.[0].data).toMatchObject({
        connectionId: REPO,
        filters: { jql: 'status = "To Do"' },
        source: JIRA_FILTER_NEW_ISSUE,
      });
    });

    it('drops a trailing ORDER BY before asking, as the poller does', async () => {
      const res = await post({ ...JIRA, filters: { jql: 'status = Open ORDER BY created DESC' } });
      expect(res.statusCode).toBe(201);
      expect(jira.searchIssues.mock.calls[0]?.[0]).toBe('project in ("PAY") AND (status = Open)');
    });

    it.each([
      ['an empty allowlist', () => (settings.jiraProjects = []), 'NO_ALLOWED_PROJECTS'],
      [
        'a tracker that is not Jira',
        () => (tracker.config = { ...tracker.config, provider: 'linear' }),
        'TRACKER_NOT_CONFIGURED',
      ],
      [
        'a Jira that is not configured',
        () => (tracker.config = { ...tracker.config, apiToken: null }),
        'TRACKER_NOT_CONFIGURED',
      ],
    ])('refuses to save an enabled one with %s, asking Jira nothing', async (_l, arrange, code) => {
      arrange();
      const res = await post(JIRA);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
      expect(jira.searchIssues).not.toHaveBeenCalled();
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('refuses JQL whose parentheses are unbalanced, asking Jira nothing', async () => {
      const res = await post({
        ...JIRA,
        filters: { jql: 'x = 1) OR project = SECRET OR (x = 1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_FILTERS');
      expect(jira.searchIssues).not.toHaveBeenCalled();
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('answers JQL_REJECTED, and stores nothing, when Jira refuses the query', async () => {
      jira.searchIssues.mockRejectedValue(
        new AtlassianError(400, 'server', 'Atlassian request failed: 400')
      );
      const res = await post(JIRA);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('JQL_REJECTED');
      expect(JSON.stringify(res.json())).not.toContain('Atlassian request failed');
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an auth failure', new AtlassianError(401, 'auth', 'Atlassian auth failed: 401')],
      ['a server error', new AtlassianError(503, 'server', 'Atlassian server error: 503')],
      ['a network error', new AtlassianError(0, 'network', 'ECONNREFUSED internal-host')],
      ['something unexpected', new Error('boom with a token abc123')],
    ])('answers 502 TRACKER_UNAVAILABLE, and stores nothing, on %s', async (_l, error) => {
      jira.searchIssues.mockRejectedValue(error);
      const res = await post(JIRA);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('TRACKER_UNAVAILABLE');
      expect(JSON.stringify(res.json())).not.toMatch(/internal-host|abc123|auth failed/);
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('saves a disabled draft without asking Jira, even with an empty allowlist', async () => {
      settings.jiraProjects = [];
      const res = await post({ ...JIRA, enabled: false });
      expect(res.statusCode).toBe(201);
      expect(jira.searchIssues).not.toHaveBeenCalled();
    });

    it('saves without asking Jira while the team’s polling switch is off, as other sources do', async () => {
      settings.jiraPolling = false;
      const res = await post(JIRA);
      expect(res.statusCode).toBe(201);
      expect(jira.searchIssues).not.toHaveBeenCalled();
    });

    it('still refuses an empty allowlist or an unconfigured tracker while the switch is off', async () => {
      settings.jiraPolling = false;
      settings.jiraProjects = [];
      const res = await post(JIRA);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('NO_ALLOWED_PROJECTS');
    });

    it('asks Jira without retries, so a save fails fast and cannot multiply load', async () => {
      await post(JIRA);
      const factory = createIssueTrackerProvider as unknown as ReturnType<typeof vi.fn>;
      expect(factory.mock.calls[0]?.[0]).toMatchObject({ maxRetries: 0, provider: 'jira' });
    });

    it('limits how often one user may create or change an automation', async () => {
      const configs = new Map<string, unknown>();
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.addHook('onRoute', (route) => {
        for (const method of [route.method].flat()) {
          configs.set(`${method} ${route.url}`, route.config);
        }
      });
      app.decorate('prisma', {} as never);
      await app.register(automationRoutes, { prefix: '/api/v1/automations' });
      await app.ready();
      await app.close();
      for (const route of [
        'POST /api/v1/automations/events',
        'PATCH /api/v1/automations/events/:id',
      ]) {
        expect(configs.get(route), route).toMatchObject({
          rateLimit: { max: 20, timeWindow: '1 minute' },
        });
      }
    });

    describe('changing one', () => {
      it('asks Jira again when the JQL changes, and leaves the baseline to the poller, which takes a new one for a new JQL', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(storedJira());
        const res = await patch({ filters: { jql: 'status = Open' } });
        expect(res.statusCode).toBe(200);
        expect(jira.searchIssues).toHaveBeenCalledTimes(1);
        expect(ctx.prisma.automationPollState.updateMany).not.toHaveBeenCalled();
      });

      it('asks Jira and resets the baseline, before the write, when an automation is switched on', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(storedJira({ enabled: false }));
        const res = await patch({ enabled: true });
        expect(res.statusCode).toBe(200);
        expect(jira.searchIssues).toHaveBeenCalledTimes(1);
        expect(ctx.prisma.automationPollState.updateMany).toHaveBeenCalledWith({
          data: { baselinedAt: null },
          where: { automationId: AUTOMATION },
        });
        const reset = ctx.prisma.automationPollState.updateMany.mock.invocationCallOrder[0] ?? 0;
        const write = ctx.prisma.automation.update.mock.invocationCallOrder[0] ?? 0;
        expect(reset).toBeLessThan(write);
      });

      it('does neither for an edit that leaves the JQL and the switch alone', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(storedJira());
        const res = await patch({ name: 'renamed' });
        expect(res.statusCode).toBe(200);
        expect(jira.searchIssues).not.toHaveBeenCalled();
        expect(ctx.prisma.automationPollState.updateMany).not.toHaveBeenCalled();
      });

      it('does not ask Jira, and resets nothing, when the JQL of a disabled one changes', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(storedJira({ enabled: false }));
        const res = await patch({ filters: { jql: 'status = Open' } });
        expect(res.statusCode).toBe(200);
        expect(jira.searchIssues).not.toHaveBeenCalled();
        expect(ctx.prisma.automationPollState.updateMany).not.toHaveBeenCalled();
      });

      it('changes nothing when Jira refuses the new JQL', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(storedJira());
        jira.searchIssues.mockRejectedValue(new AtlassianError(400, 'server', 'bad'));
        const res = await patch({ filters: { jql: 'nonsense' } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('JQL_REJECTED');
        expect(ctx.prisma.automation.update).not.toHaveBeenCalled();
        expect(ctx.prisma.automationPollState.updateMany).not.toHaveBeenCalled();
      });

      it('resets no baseline for an automation of another source', async () => {
        ctx.prisma.automation.findUnique.mockResolvedValue(stored({ enabled: false }));
        await patch({ enabled: true });
        expect(ctx.prisma.automationPollState.updateMany).not.toHaveBeenCalled();
      });
    });
  });
});
