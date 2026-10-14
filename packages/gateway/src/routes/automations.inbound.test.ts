/**
 * `inbound.event` automations through the automation routes: team automations on one of the
 * team's event endpoints, optionally acting on a repository the team owns or is shared.
 */
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { INBOUND_EVENT } from '@auto-swe/shared/automation';
import { authorizeLaunch } from '../lib/launchAuthorization.js';
import { automationRoutes } from './automations.js';

const TEAM = '55555555-5555-4555-8555-555555555555';
const ENDPOINT = '77777777-7777-4777-8777-777777777777';
const REPO = '11111111-1111-4111-8111-111111111111';
const AUTOMATION = '22222222-2222-4222-8222-222222222222';
const FIRE = '44444444-4444-4444-8444-444444444444';
const TEMPLATE_ID = 'b0000000-0000-4000-8000-000000000000';
const URL = '/api/v1/automations/events';
const AUTH = { authorization: 'Bearer fake' };
const ORG = { id: 'org-1', monthlyBudgetUsdCents: 5000 };

const teamRow = (role: string | null) => ({
  id: TEAM,
  isActive: true,
  memberships: role ? [{ role }] : [],
  name: 'Platform',
  organization: ORG,
  orgId: ORG.id,
});

const FILTERS = {
  endpointId: ENDPOINT,
  eventTypes: ['alert.*'],
  fields: { severity: '/severity' },
  match: [],
};
const VALID = {
  filters: FILTERS,
  name: 'alerts',
  source: INBOUND_EVENT,
  teamId: TEAM,
  templateId: TEMPLATE_ID,
};
const TEMPLATE = {
  activeVersion: 1,
  id: TEMPLATE_ID,
  inputSchema: {
    properties: {
      description: { type: 'string' },
      severity: { enum: ['low', 'high'], type: 'string' },
    },
    required: [],
    type: 'object',
  },
  workspaceProvider: null,
};
const stored = (over: Record<string, unknown> = {}) => ({
  connectionId: null,
  enabled: true,
  filters: FILTERS,
  id: AUTOMATION,
  inputs: {},
  source: INBOUND_EVENT,
  targetConnectionId: null,
  teamId: TEAM,
  templateId: TEMPLATE_ID,
  ...over,
});
const FACTS = {
  endpointId: ENDPOINT,
  fields: { severity: 'high' },
  id: 'e1',
  scope: 'alert.fired',
  subject: 'e1',
  type: 'alert.fired',
  values: {},
};
const launchRepo = {
  id: REPO,
  isActive: true,
  shares: [],
  team: { memberships: [], organization: ORG, orgId: 'org-2' },
  teamId: 'team-2',
  type: 'git_repo',
};

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = {
    automation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: AUTOMATION,
        ...data,
      })),
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...stored(),
        ...data,
      })),
    },
    automationFire: { findFirst: vi.fn() },
    configAuditLog: { create: vi.fn(async () => ({})) },
    connection: { findFirst: vi.fn(async (_args: unknown) => null as unknown) },
    eventEndpoint: {
      findFirst: vi.fn(async (_args: unknown) => ({ enabled: true, id: ENDPOINT }) as unknown),
    },
    team: { findUnique: vi.fn(async () => teamRow('LEAD')) },
    workflowTemplate: { findFirst: vi.fn(async () => TEMPLATE) },
  };
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
  } as unknown as never);
  await app.register(automationRoutes, { prefix: '/api/v1/automations' });
  await app.ready();
  return { app, prisma };
}

describe('automationRoutes (inbound.event)', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    ctx.prisma.team.findUnique.mockResolvedValue(teamRow('LEAD'));
    ctx.prisma.automation.findUnique.mockResolvedValue(stored());
    ctx.prisma.eventEndpoint.findFirst.mockResolvedValue({ enabled: true, id: ENDPOINT });
    ctx.prisma.connection.findFirst.mockResolvedValue(null);
  });
  const post = (payload: Record<string, unknown>) =>
    ctx.app.inject({ headers: AUTH, method: 'POST', payload, url: URL });
  const retry = () =>
    ctx.app.inject({
      headers: AUTH,
      method: 'POST',
      url: `${URL}/${AUTOMATION}/fires/${FIRE}/retry`,
    });

  it('creates a team automation on one of the team’s endpoints', async () => {
    const res = await post(VALID);
    expect(res.statusCode).toBe(201);
    expect(ctx.prisma.automation.create.mock.calls[0]?.[0].data).toMatchObject({
      filters: FILTERS,
      source: INBOUND_EVENT,
      targetConnectionId: null,
      teamId: TEAM,
    });
    expect(JSON.stringify(ctx.prisma.eventEndpoint.findFirst.mock.calls[0]?.[0])).toContain(TEAM);
  });

  it('refuses a repository owner, another team’s endpoint, and no template', async () => {
    const onRepo = await post({ ...VALID, connectionId: REPO, teamId: undefined });
    expect(onRepo.statusCode).toBe(404);
    ctx.prisma.eventEndpoint.findFirst.mockResolvedValue(null);
    const foreign = await post(VALID);
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe('INVALID_FILTERS');
    ctx.prisma.eventEndpoint.findFirst.mockResolvedValue({ enabled: true, id: ENDPOINT });
    const none = await post({ ...VALID, templateId: null });
    expect(none.json().error.code).toBe('TEMPLATE_REQUIRED');
    expect(ctx.prisma.automation.create).not.toHaveBeenCalled();
  });

  it('refuses a mapped field the template does not declare, or one an option also sets', async () => {
    const undeclared = await post({ ...VALID, filters: { ...FILTERS, fields: { other: '/x' } } });
    expect(undeclared.json().error.code).toBe('INVALID_INPUTS');
    const both = await post({ ...VALID, inputs: { severity: 'low' } });
    expect(both.json().error.code).toBe('INVALID_INPUTS');
  });

  it('acts on a repository the team reaches only, deciding the launch on it', async () => {
    const unreachable = await post({ ...VALID, targetConnectionId: REPO });
    expect(unreachable.statusCode).toBe(400);
    expect(unreachable.json().error.code).toBe('TARGET_REPOSITORY_NOT_REACHABLE');
    // Reachable: shared with the team (the query asks for owned or shared).
    ctx.prisma.connection.findFirst.mockImplementation(async () => launchRepo);
    const ok = await post({ ...VALID, targetConnectionId: REPO });
    expect(ok.statusCode).toBe(201);
    const reach = JSON.stringify(ctx.prisma.connection.findFirst.mock.calls[0]?.[0]);
    expect(reach).toContain(`"shares":{"some":{"teamId":"${TEAM}"}}`);
    expect(vi.mocked(authorizeLaunch).mock.calls[0]?.[2]).toMatchObject({
      orgs: [ORG],
      repos: [launchRepo],
    });
    expect(ctx.prisma.automation.create.mock.calls[0]?.[0].data.targetConnectionId).toBe(REPO);
  });

  it('takes an event decision again on its endpoint’s key, and on no other', async () => {
    ctx.prisma.automationFire.findFirst.mockResolvedValue({
      facts: FACTS,
      id: FIRE,
      outcome: 'SUPPRESSED_COOLDOWN',
      ownerKey: `@endpoint/${ENDPOINT}`,
      retriedAt: null,
    });
    engine.decideAndStart.mockResolvedValue({ automationId: AUTOMATION, outcome: 'STARTED' });
    const res = await retry();
    expect(res.statusCode).toBe(200);
    expect(engine.decideAndStart.mock.calls[0]?.[2]).toMatchObject({
      connection: null,
      ownerKey: `@endpoint/${ENDPOINT}`,
      retry: { fireId: FIRE, kind: 'manual' },
    });

    for (const ownerKey of [
      `@team/${TEAM}`,
      '@endpoint/88888888-8888-4888-8888-888888888888',
      'github.com/a/b',
    ]) {
      engine.decideAndStart.mockClear();
      ctx.prisma.automationFire.findFirst.mockResolvedValue({
        facts: FACTS,
        id: FIRE,
        outcome: 'SUPPRESSED_COOLDOWN',
        ownerKey,
        retriedAt: null,
      });
      expect((await retry()).statusCode).toBe(409);
      expect(engine.decideAndStart).not.toHaveBeenCalled();
    }
  });

  it('does not take a decision again once its endpoint is disabled or gone', async () => {
    ctx.prisma.automationFire.findFirst.mockResolvedValue({
      facts: FACTS,
      id: FIRE,
      outcome: 'FAILED_TO_START',
      ownerKey: `@endpoint/${ENDPOINT}`,
      retriedAt: null,
    });
    for (const endpoint of [{ enabled: false }, null]) {
      ctx.prisma.eventEndpoint.findFirst.mockResolvedValue(endpoint);
      const res = await retry();
      expect(res.statusCode).toBe(409);
    }
    expect(engine.decideAndStart).not.toHaveBeenCalled();
  });

  it('retries on the target repository, or records it unusable', async () => {
    ctx.prisma.automation.findUnique.mockResolvedValue(stored({ targetConnectionId: REPO }));
    ctx.prisma.automationFire.findFirst.mockResolvedValue({
      facts: FACTS,
      id: FIRE,
      outcome: 'FAILED_TO_START',
      ownerKey: `@endpoint/${ENDPOINT}`,
      retriedAt: null,
    });
    engine.decideAndStart.mockResolvedValue({
      automationId: AUTOMATION,
      outcome: 'FAILED_TO_START',
    });
    await retry();
    expect(engine.decideAndStart.mock.calls[0]?.[2]).toMatchObject({
      connection: null,
      targetUnavailable: expect.stringContaining('no longer owned by or shared with'),
    });
  });
});
