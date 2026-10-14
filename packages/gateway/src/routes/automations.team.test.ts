/**
 * Event automations that belong to a TEAM, not a repository. No shipped source targets a team,
 * so these register a test-only one (`test/fakeTeamSource.ts`) beside the real sources.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/automation', async (orig) =>
  (await import('../test/fakeTeamSource.js')).withFakeTeamSource(await orig())
);
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => undefined) }));

const engine = vi.hoisted(() => ({ decideAndStart: vi.fn() }));
vi.mock('../lib/automations/engine.js', async (orig) => ({
  ...(await orig<typeof import('../lib/automations/engine.js')>()),
  decideAndStart: engine.decideAndStart,
}));

vi.mock('../lib/launchAuthorization.js', () => ({
  authorizeLaunch: vi.fn(async () => ({ ok: true })),
  sendLaunchRefusal: vi.fn(),
}));

import { WORKFLOW_RUN_FAILED } from '@auto-swe/shared/automation';
import { authorizeLaunch } from '../lib/launchAuthorization.js';
import { FAKE_TEAM_SOURCE } from '../test/fakeTeamSource.js';
import { automationRoutes } from './automations.js';

const TEAM = '55555555-5555-4555-8555-555555555555';
const REPO = '11111111-1111-4111-8111-111111111111';
const AUTOMATION = '22222222-2222-4222-8222-222222222222';
const FIRE = '44444444-4444-4444-8444-444444444444';
const URL = '/api/v1/automations/events';
const AUTH = { authorization: 'Bearer fake' };
const ORG = { id: 'org-1', monthlyBudgetUsdCents: 5000 };

function teamRow(role: string | null, isActive = true) {
  return {
    id: TEAM,
    isActive,
    memberships: role ? [{ role }] : [],
    name: 'Platform',
    organization: ORG,
    orgId: ORG.id,
  };
}

const stored = (over: Record<string, unknown> = {}) => ({
  connectionId: null,
  enabled: true,
  filters: { topics: ['deploys'] },
  id: AUTOMATION,
  inputs: {},
  source: FAKE_TEAM_SOURCE,
  teamId: TEAM,
  templateId: null,
  ...over,
});

const VALID = { filters: { topics: ['deploys'] }, name: 'deploys', source: FAKE_TEAM_SOURCE };

const TEMPLATE = {
  activeVersion: 1,
  id: 'b0000000-0000-4000-8000-000000000000',
  inputSchema: { properties: { description: { type: 'string' } }, required: [], type: 'object' },
  workspaceProvider: null,
};

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
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    automationFire: {
      findFirst: vi.fn(),
      findMany: vi.fn(async (_args: unknown) => [] as unknown[]),
      groupBy: vi.fn(async (_args: unknown) => [] as unknown[]),
    },
    configAuditLog: { create: vi.fn(async () => ({})) },
    connection: { findFirst: vi.fn(async () => null) },
    team: { findUnique: vi.fn() },
    workflowRun: { findFirst: vi.fn(async () => null) },
    workflowTemplate: {
      findFirst: vi.fn(async () => TEMPLATE),
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

describe('automationRoutes (team automations)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.auth.role = 'ENGINEER';
    vi.clearAllMocks();
    ctx.prisma.automation.findUnique.mockResolvedValue(stored());
    ctx.prisma.workflowTemplate.findFirst.mockResolvedValue(TEMPLATE);
  });

  const get = (url: string) => ctx.app.inject({ headers: AUTH, method: 'GET', url });
  const post = (payload: Record<string, unknown>) =>
    ctx.app.inject({ headers: AUTH, method: 'POST', payload, url: URL });

  describe('reading', () => {
    it('lists a team’s automations to its members, scoped to the team', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('MEMBER'));
      const res = await get(`${URL}?teamId=${TEAM}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.canManage).toBe(false);
      expect(ctx.prisma.automation.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { connectionId: null, teamId: TEAM },
      });
    });

    it('404s a team the caller is not a member of, and reads nothing of it', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow(null));
      const res = await get(`${URL}?teamId=${TEAM}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TEAM_NOT_FOUND');
      expect(ctx.prisma.automation.findMany).not.toHaveBeenCalled();
    });

    it('needs exactly one of a repository and a team', async () => {
      expect((await get(URL)).statusCode).toBe(400);
      expect((await get(`${URL}?teamId=${TEAM}&connectionId=${REPO}`)).statusCode).toBe(400);
    });

    it('shows a team automation’s decisions to members only', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('MEMBER'));
      ctx.prisma.automationFire.findMany.mockResolvedValue([{ outcome: 'STARTED' }]);
      const res = await get(`${URL}/${AUTOMATION}/fires`);
      expect(res.statusCode).toBe(200);
      expect(ctx.prisma.automationFire.findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { automationId: AUTOMATION },
      });
      // Another team's member: no automation, no decisions.
      vi.clearAllMocks();
      ctx.prisma.automation.findUnique.mockResolvedValue(stored());
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow(null));
      expect((await get(`${URL}/${AUTOMATION}/fires`)).statusCode).toBe(404);
      expect(ctx.prisma.automationFire.findMany).not.toHaveBeenCalled();
      expect(ctx.prisma.connection.findFirst).not.toHaveBeenCalled();
    });

    it('lists a team automation with its team instead of a repository', async () => {
      ctx.prisma.automation.findMany.mockResolvedValue([
        {
          ...stored(),
          connection: null,
          createdAt: new Date(0),
          name: 'deploys',
          team: { id: TEAM, memberships: [{ role: 'LEAD' }], name: 'Platform' },
          template: null,
        },
      ]);
      const res = await get('/api/v1/automations');
      expect(res.statusCode).toBe(200);
      const [row] = res.json().data;
      expect(row).toMatchObject({
        canManage: true,
        kind: 'event',
        repository: null,
        team: { id: TEAM, name: 'Platform' },
        when: expect.stringContaining('When a team event arrives'),
      });
      // The caller's own membership role is not echoed back on the automation.
      expect(row.automation.team).toEqual({ id: TEAM, name: 'Platform' });
      // A team automation reaches a non-admin only through membership of its team.
      const where = JSON.stringify(ctx.prisma.automation.findMany.mock.calls[0]?.[0]);
      expect(where).toContain('"connectionId":null');
      expect(where).toContain('"memberships":{"some":{"userId":"user-1"}}');
    });
  });

  describe('managing', () => {
    it('lets a team LEAD create one, deciding the launch against the team’s organization', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD'));
      const res = await post({ ...VALID, teamId: TEAM });
      expect(res.statusCode).toBe(201);
      const data = ctx.prisma.automation.create.mock.calls[0]?.[0].data;
      expect(data).toMatchObject({ source: FAKE_TEAM_SOURCE, teamId: TEAM });
      expect(data).not.toHaveProperty('connectionId');
      expect(vi.mocked(authorizeLaunch).mock.calls[0]?.[2]).toMatchObject({
        orgs: [ORG],
        repos: [],
      });
      expect(ctx.prisma.configAuditLog.create).toHaveBeenCalled();
    });

    it('lets an ADMIN create one on any team', async () => {
      ctx.auth.role = 'ADMIN';
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow(null));
      expect((await post({ ...VALID, teamId: TEAM })).statusCode).toBe(201);
    });

    it('refuses a plain member, and hides the team from a non-member', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('MEMBER'));
      expect((await post({ ...VALID, teamId: TEAM })).statusCode).toBe(403);
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow(null));
      expect((await post({ ...VALID, teamId: TEAM })).statusCode).toBe(404);
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('refuses an inactive team', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD', false));
      const res = await post({ ...VALID, teamId: TEAM });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('TEAM_INACTIVE');
    });

    it('keeps every shipped source on a repository, and a team source off one', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD'));
      const onTeam = await post({
        filters: {
          branchPatterns: ['main'],
          events: ['push'],
          workflowPatterns: ['.github/workflows/**'],
        },
        name: 'ci',
        source: WORKFLOW_RUN_FAILED,
        teamId: TEAM,
      });
      expect(onTeam.statusCode).toBe(400);
      expect(onTeam.json().error.code).toBe('SOURCE_TARGET_MISMATCH');

      ctx.prisma.connection.findFirst.mockResolvedValue({
        id: REPO,
        isActive: true,
        shares: [],
        team: { memberships: [{ role: 'LEAD', userId: 'user-1' }], orgId: 'org-1' },
        teamId: 'team-1',
        type: 'git_repo',
      } as never);
      const onRepo = await post({ ...VALID, connectionId: REPO });
      expect(onRepo.statusCode).toBe(400);
      expect(onRepo.json().error.code).toBe('SOURCE_TARGET_MISMATCH');
      expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
    });

    it('deletes for a team LEAD', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD'));
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'DELETE',
        url: `${URL}/${AUTOMATION}`,
      });
      expect(res.statusCode).toBe(204);
    });

    it('takes a decision again on the team, with no repository', async () => {
      ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD'));
      ctx.prisma.automationFire.findFirst.mockResolvedValue({
        facts: { eventId: 'e1', topic: 'deploys' },
        id: FIRE,
        outcome: 'SUPPRESSED_COOLDOWN',
        ownerKey: `@team/${TEAM}`,
        retriedAt: null,
      });
      engine.decideAndStart.mockResolvedValue({ automationId: AUTOMATION, outcome: 'STARTED' });
      const res = await ctx.app.inject({
        headers: AUTH,
        method: 'POST',
        url: `${URL}/${AUTOMATION}/fires/${FIRE}/retry`,
      });
      expect(res.statusCode).toBe(200);
      expect(engine.decideAndStart.mock.calls[0]?.[2]).toMatchObject({
        connection: null,
        ownerKey: `@team/${TEAM}`,
        retry: { fireId: FIRE, kind: 'manual' },
        team: { id: TEAM, organization: ORG, orgId: ORG.id },
      });
      expect(ctx.prisma.connection.findFirst).not.toHaveBeenCalled();
    });
  });
});
