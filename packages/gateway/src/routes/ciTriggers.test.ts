import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciTriggerRoutes } from './ciTriggers.js';

const REPO = '11111111-1111-4111-8111-111111111111';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const URL = `/api/v1/repositories/${REPO}/ci-triggers`;
const AUTH = { authorization: 'Bearer fake' };

type Membership = { role: string; userId: string } | null;

function repoRow(owning: Membership, shared: Membership = null) {
  return {
    id: REPO,
    isActive: true,
    shares: shared ? [{ team: { memberships: [shared] } }] : [],
    team: { memberships: owning ? [owning] : [] },
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
    connection: { findUnique: vi.fn() },
    workflowTemplate: { findFirst: vi.fn() },
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
    vi.clearAllMocks();
  });

  const lead = { role: 'LEAD', userId: 'user-1' };
  const member = { role: 'MEMBER', userId: 'user-1' };

  describe('reading', () => {
    it('lists the triggers to a member, saying whether they may manage them', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(member));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ canManage: false, triggers: [] });
    });

    it('lets a member of a SHARED team read, but not manage', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(null, lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.json().data.canManage).toBe(false);
    });

    it('404s a repository the caller is not a member of', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({ headers: AUTH, method: 'GET', url: URL });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('creating', () => {
    it('lets a LEAD of the owning team create one, with safe defaults', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(201);
      expect(ctx.prisma.ciFailureTrigger.create.mock.calls[0]?.[0].data).toMatchObject({
        commentOnPullRequest: true,
        connectionId: REPO,
        createdById: 'user-1',
        events: ['push'],
        mode: 'TRIAGE_ONLY',
        workflowPatterns: ['.github/workflows/**'],
      });
      expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('refuses a plain member and a shared team’s lead', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(member));
      let res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(403);
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(null, lead));
      res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(403);
      expect(ctx.prisma.ciFailureTrigger.create).not.toHaveBeenCalled();
    });

    it.each([
      ['no branch patterns', { ...VALID, branchPatterns: [] }],
      ['only exclusions', { ...VALID, branchPatterns: ['!main'] }],
      ['an event that is never acted on', { ...VALID, events: ['pull_request_target'] }],
      ['an unknown mode', { ...VALID, mode: 'AUTO_MERGE' }],
      ['a negative cooldown', { ...VALID, cooldownMinutes: -1 }],
      ['a zero daily cap', { ...VALID, maxRunsPerDay: 0 }],
    ])('rejects %s', async (_label, payload) => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(lead));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload, url: URL });
      expect(res.statusCode).toBe(400);
    });

    it("refuses a template that is not active and global or the team's", async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(lead));
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
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(null));
      const res = await ctx.app.inject({ headers: AUTH, method: 'POST', payload: VALID, url: URL });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('changing and removing', () => {
    it('updates and audits with before and after', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(lead));
      ctx.prisma.ciFailureTrigger.findFirst.mockResolvedValue({ id: TRIGGER, mode: 'TRIAGE_ONLY' });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'PATCH',
        payload: { mode: 'FIX' },
        url: `${URL}/${TRIGGER}`,
      });
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.configAuditLog.create.mock.calls[0]?.[0].data).toMatchObject({
        action: 'UPDATE',
        entityType: 'CiFailureTrigger',
      });
    });

    it('404s a trigger of another repository', async () => {
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(lead));
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
      ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(member));
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
    ctx.prisma.connection.findUnique.mockResolvedValue(repoRow(member));
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
