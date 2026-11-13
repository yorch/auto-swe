import { ConnectionTypeSchema } from '@auto-swe/shared/lib/connectionTypes';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  authorize: vi.fn(),
  launch: vi.fn(),
  settings: vi.fn(),
  shell: vi.fn(),
}));
vi.mock('@auto-swe/shared', () => ({
  ConnectionTypeSchema,
  Prisma: { DbNull: {} },
  Role: { ADMIN: 'ADMIN', ENGINEER: 'ENGINEER', LEAD: 'LEAD' },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: m.settings }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));
vi.mock('../lib/launchAuthorization.js', async (original) => ({
  ...(await original<object>()),
  authorizeLaunch: m.authorize,
}));
vi.mock('../lib/workflowLaunch.js', () => ({ launchTrackedWorkflow: m.launch }));
vi.mock('../lib/specCheck.js', async (original) => ({
  ...(await original<object>()),
  isShellAuthor: m.shell,
}));

import { autoRunRepoOnboarding } from '../lib/repoOnboardingLaunch.js';
import { repositoryRoutes } from './repositories.js';

const REPO = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const apps: ReturnType<typeof Fastify>[] = [];
async function build() {
  const app = Fastify();
  apps.push(app);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const actor = { role: 'ADMIN', sub: 'user-1' };
  const repo = {
    id: REPO,
    installation: null,
    isActive: true,
    shares: [],
    team: {
      id: TEAM,
      isActive: true,
      memberships: [{ userId: actor.sub }],
      monthlyBudgetUsdCents: null,
      name: 'Team',
      organization: { monthlyBudgetUsdCents: null },
      orgId: 'org-1',
    },
    teamId: TEAM,
    type: 'git_repo',
  };
  const created = new Map<string, typeof repo>();
  const prisma = {
    activeWorkflow: { findUnique: vi.fn().mockResolvedValue(null) },
    configAuditLog: { create: vi.fn().mockResolvedValue({}) },
    connection: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = created.size === 0 ? REPO : '33333333-3333-4333-8333-333333333333';
        const row = { ...repo, ...data, id };
        created.set(id, row);
        return row;
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => created.get(where.id) ?? repo
      ),
    },
    team: { findUnique: vi.fn().mockResolvedValue({ id: TEAM, isActive: true, orgId: 'org-1' }) },
    teamMembership: {
      findUnique: vi.fn().mockResolvedValue({ role: 'ADMIN', team: { isActive: true } }),
    },
    workflowRun: { findFirst: vi.fn().mockResolvedValue(null) },
    workflowTemplate: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ activeVersion: 1, id: 'template-1', inputSchema: null }),
    },
  };
  const temporal = {
    startRepoDependencyScan: vi.fn().mockResolvedValue(undefined),
    startRunnableWorkflow: vi.fn().mockResolvedValue(undefined),
  };
  app.decorate('prisma', prisma as never);
  app.decorate('temporal', temporal as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ ...actor, exp: 9999999999, iat: 0 }),
  } as never);
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.ready();
  const post = (key?: string, authenticated = true) =>
    app.inject({
      headers: {
        ...(authenticated ? { authorization: 'Bearer test' } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      method: 'POST',
      url: `/api/v1/repositories/${REPO}/onboarding-runs`,
    });
  return { actor, app, post, prisma, repo, temporal };
}
beforeEach(() => {
  vi.resetAllMocks();
  m.authorize.mockResolvedValue({ ok: true });
  m.shell.mockResolvedValue(true);
  m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': false });
  m.launch.mockImplementation(async (_prisma, _rows, start) => {
    await start();
    return { activeWorkflowId: 'active-1', ok: true };
  });
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('onboarding run trigger', () => {
  it.each([false, true])('direct creation auto-onboarding enabled: %s', async (enabled) => {
    const ctx = await build();
    m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': enabled });
    const response = await ctx.app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: { organizationName: 'acme', repoName: 'api', teamId: TEAM },
      url: '/api/v1/repositories',
    });
    expect(response.statusCode).toBe(201);
    expect(ctx.temporal.startRepoDependencyScan).toHaveBeenCalledExactlyOnceWith(REPO);
    expect(m.launch).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(ctx.temporal.startRunnableWorkflow).toHaveBeenCalledTimes(enabled ? 1 : 0);
    if (enabled) {
      expect(m.launch.mock.calls[0]?.[1].runInput).toMatchObject({
        connectionId: REPO,
        requestedById: 'user-1',
      });
      expect(ctx.temporal.startRepoDependencyScan.mock.invocationCallOrder[0]).toBeLessThan(
        m.launch.mock.invocationCallOrder[0] ?? 0
      );
    }
  });
  it.each([false, true])('bulk import auto-onboarding enabled: %s', async (enabled) => {
    const ctx = await build();
    m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': enabled });
    const response = await ctx.app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: {
        repos: ['first', 'second'].map((repoName) => ({
          installationId: null,
          organizationName: 'acme',
          repoName,
        })),
        teamId: TEAM,
      },
      url: '/api/v1/repositories/import',
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data;
    expect(rows.map((row: { status: string }) => row.status)).toEqual(['created', 'created']);
    expect(ctx.temporal.startRepoDependencyScan).toHaveBeenCalledTimes(2);
    expect(m.launch).toHaveBeenCalledTimes(enabled ? 2 : 0);
    expect(ctx.temporal.startRunnableWorkflow).toHaveBeenCalledTimes(enabled ? 2 : 0);
    if (enabled) {
      expect(m.launch.mock.calls.map((call) => call[1].runInput.connectionId)).toEqual(
        rows.map((row: { id: string }) => row.id)
      );
      for (const [index, call] of m.launch.mock.calls.entries()) {
        expect(call[1].runInput.requestedById).toBe('user-1');
        expect(ctx.temporal.startRepoDependencyScan.mock.invocationCallOrder[index]).toBeLessThan(
          m.launch.mock.invocationCallOrder[index] ?? 0
        );
      }
    }
  });
  it('a failed auto-launch does not fail an import or stop later repositories', async () => {
    const ctx = await build();
    m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': true });
    m.launch.mockRejectedValueOnce(new Error('Temporal unavailable'));
    const response = await ctx.app.inject({
      headers: { authorization: 'Bearer test' },
      method: 'POST',
      payload: {
        repos: ['first', 'second'].map((repoName) => ({
          installationId: null,
          organizationName: 'acme',
          repoName,
        })),
        teamId: TEAM,
      },
      url: '/api/v1/repositories/import',
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data;
    expect(rows.map((row: { status: string }) => row.status)).toEqual(['created', 'created']);
    expect(m.launch).toHaveBeenCalledTimes(2);
    expect(ctx.temporal.startRunnableWorkflow).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ request: expect.objectContaining({ connectionId: rows[1].id }) })
    );
    expect(ctx.prisma.configAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          afterJson: { onboardingAutoRun: 'failed' },
          entityId: rows[0].id,
        }),
      })
    );
  });
  it('requires authentication and LEAD role', async () => {
    const ctx = await build();
    expect((await ctx.post(undefined, false)).statusCode).toBe(401);
    ctx.actor.role = 'ENGINEER';
    expect((await ctx.post()).statusCode).toBe(403);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('requires repo management and shell authoring', async () => {
    const ctx = await build();
    ctx.actor.role = 'LEAD';
    m.shell.mockResolvedValue(false);
    expect((await ctx.post()).statusCode).toBe(403);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('rejects a non-git connection', async () => {
    const ctx = await build();
    ctx.repo.type = 'api_only';
    expect((await ctx.post()).statusCode).toBe(400);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it.each([null, { activeVersion: null, id: 'template-1' }])(
    'rejects an unavailable template: %j',
    async (template) => {
      const ctx = await build();
      ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(template);
      expect((await ctx.post()).statusCode).toBe(404);
      expect(m.launch).not.toHaveBeenCalled();
      expect(ctx.prisma.workflowTemplate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ origin: 'swe-starter', status: 'ACTIVE', teamId: null }),
        })
      );
    }
  );
  it('uses the canonical budget decision before writing any ledger rows', async () => {
    const ctx = await build();
    m.authorize.mockResolvedValue({
      ok: false,
      refusal: { body: { error: { code: 'ORG_BUDGET_EXCEEDED' } }, status: 402 },
    });
    expect((await ctx.post()).statusCode).toBe(402);
    expect(m.launch).not.toHaveBeenCalled();
  });
  it('starts a tracked, attributed run and deduplicates repeated keys', async () => {
    const ctx = await build();
    const first = await ctx.post('intent-1');
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ runId: null, workflowId: 'active-1' });
    const rows = m.launch.mock.calls[0]?.[1];
    expect(rows.runInput).toMatchObject({
      connectionId: REPO,
      payload: { connectionId: REPO },
      requestedById: 'user-1',
      templateId: 'template-1',
      templateVersion: 1,
    });
    expect(rows.activeWorkflow.budgetTier).toBe('STANDARD');
    expect(ctx.temporal.startRunnableWorkflow).toHaveBeenCalledExactlyOnceWith(
      first.json().data.temporalWorkflowId,
      expect.objectContaining({
        request: expect.objectContaining({ connectionId: REPO, launchedById: 'user-1' }),
      })
    );
    ctx.prisma.activeWorkflow.findUnique.mockResolvedValue({
      id: 'active-1',
      workRequestId: first.json().data.workRequestId,
    });
    ctx.prisma.workflowRun.findFirst.mockResolvedValue({ id: 'run-1' });
    const second = await ctx.post('intent-1');
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({
      deduplicated: true,
      runId: 'run-1',
      workRequestId: first.json().data.workRequestId,
    });
    expect(m.launch).toHaveBeenCalledTimes(1);
  });
  it('joins the winner of a concurrent idempotent launch', async () => {
    const ctx = await build();
    m.launch.mockResolvedValue({ ok: false, reason: 'CONFLICT' });
    ctx.prisma.activeWorkflow.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'winner', workRequestId: 'request-1' });
    const response = await ctx.post('raced');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.deduplicated).toBe(true);
  });
  it.each([false, true])(
    'auto-run setting %s is resolved for the connection tenant',
    async (enabled) => {
      const ctx = await build();
      m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': enabled });
      const request = { log: ctx.app.log, user: ctx.actor } as never;
      await autoRunRepoOnboarding(ctx.app, request, REPO, TEAM);
      expect(m.settings).toHaveBeenCalledWith(['onboarding.autoRunOnConnect'], {
        orgId: 'org-1',
        teamId: TEAM,
      });
      expect(m.launch).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) {
        ctx.prisma.activeWorkflow.findUnique.mockResolvedValue({
          id: 'active-1',
          workRequestId: 'request-1',
        });
        await autoRunRepoOnboarding(ctx.app, request, REPO, TEAM);
        expect(m.launch).toHaveBeenCalledTimes(1);
      }
    }
  );
  it('logs and audits an automatic launch failure without rejecting creation', async () => {
    const ctx = await build();
    m.settings.mockResolvedValue({ 'onboarding.autoRunOnConnect': true });
    m.launch.mockRejectedValue(new Error('Temporal unavailable'));
    await expect(
      autoRunRepoOnboarding(ctx.app, { log: ctx.app.log, user: ctx.actor } as never, REPO, TEAM)
    ).resolves.toBeUndefined();
    expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
  });
});
