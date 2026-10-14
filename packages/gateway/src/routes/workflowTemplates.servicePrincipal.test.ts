import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

import { workflowTemplateRoutes } from './workflowTemplates.js';

/**
 * `POST /workflow-templates/:id/runs` with a service principal's token: the template allowlist,
 * the team term on the template, the org cap of a connection-less run, attribution and the
 * principal-scoped Idempotency-Key. The connection half of the decision is shared with agent runs
 * and covered in `agentRuns.servicePrincipal.test.ts`.
 */

const TEMPLATE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SP = '33333333-3333-4333-8333-333333333333';
const SP_TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';

interface State {
  templateIds: string[];
  templateTeamId: string | null;
  orgOverBudget: boolean;
  runsLastDay: number;
}

function harness(s: State) {
  const app: FastifyInstance = Fastify();
  const runInputs: Array<Record<string, unknown>> = [];
  const started: string[] = [];
  const templateWheres: unknown[] = [];
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('auth', {
    hashToken: (t: string) => `hash:${t}`,
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
  } as unknown as never);

  const tpl = () => ({
    activeVersion: 3,
    id: TEMPLATE_ID,
    inputSchema: null,
    name: 'Release notes',
    team: s.templateTeamId
      ? {
          id: s.templateTeamId,
          organization: { id: 'org-1', monthlyBudgetUsdCents: s.orgOverBudget ? 100 : null },
          orgId: 'org-1',
        }
      : null,
    teamId: s.templateTeamId,
    workspaceProvider: null,
  });

  const prisma: Record<string, unknown> = {
    $queryRaw: async () => [{ id: 'locked' }],
    activeWorkflow: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aw-1', ...data }),
      delete: async () => ({}),
    },
    apiToken: {
      findUnique: async () => ({
        expiresAt: new Date(Date.now() + 86_400_000),
        id: 'tok-1',
        revokedAt: null,
        scopes: ['runs:launch'],
        servicePrincipal: {
          connectionIds: [],
          disabledAt: null,
          id: SP,
          name: 'release-bot',
          team: { isActive: true, organization: { isActive: true } },
          teamId: SP_TEAM,
          templateIds: s.templateIds,
        },
        servicePrincipalId: SP,
        user: null,
        userId: null,
      }),
      update: async () => ({}),
    },
    orgMonthlyUsage: {
      findUnique: async () => (s.orgOverBudget ? { costUsdAccrued: 100 } : null),
    },
    runInput: {
      count: async () => s.runsLastDay,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        runInputs.push(data);
        return data;
      },
      delete: async () => ({}),
    },
    servicePrincipal: {
      findUnique: async () => ({
        connectionIds: [],
        disabledAt: null,
        maxInFlight: 5,
        maxRunsPerDay: 3,
        team: { isActive: true },
        templateIds: s.templateIds,
      }),
    },
    // The launch snapshots the template team as the run's knowledge source.
    team: {
      findUnique: async () => ({
        id: s.templateTeamId,
        isActive: true,
        organization: { isActive: true },
        orgId: 'org-1',
      }),
    },
    workflowTemplate: {
      // Evaluates the two terms the service where adds: the allowlist and the team.
      findFirst: async ({ where }: { where: { AND?: Array<Record<string, unknown>> } }) => {
        templateWheres.push(where);
        const terms = where.AND ?? [];
        const allow = terms.find((t) => (t.id as { in?: string[] })?.in) as
          | { id: { in: string[] } }
          | undefined;
        const team = terms.find((t) => t.OR) as
          | { OR: Array<{ teamId: string | null }> }
          | undefined;
        if (!allow?.id.in.includes(TEMPLATE_ID)) {
          return null;
        }
        if (!team?.OR.some((b) => b.teamId === s.templateTeamId)) {
          return null;
        }
        return tpl();
      },
    },
  };
  prisma.$transaction = async (action: (tx: unknown) => Promise<unknown>) => action(prisma);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('temporal', {
    startRunnableWorkflow: async (id: string) => {
      started.push(id);
    },
  } as unknown as never);
  app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });

  const run = (headers: Record<string, string> = {}) =>
    app.inject({
      headers: { authorization: 'Bearer ats_service', ...headers },
      method: 'POST',
      payload: { payload: { description: 'write the notes' } },
      url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
    });
  return { app, run, runInputs, started, templateWheres };
}

describe('POST /workflow-templates/:id/runs with a service principal token', () => {
  let s: State;

  beforeEach(() => {
    s = {
      orgOverBudget: false,
      runsLastDay: 0,
      templateIds: [TEMPLATE_ID],
      templateTeamId: SP_TEAM,
    };
  });

  it('runs an allowlisted template of its team, as the principal and with no launcher', async () => {
    const h = harness(s);
    const res = await h.run();
    expect(res.statusCode).toBe(201);
    expect(h.runInputs[0]).toMatchObject({
      requestedById: null,
      requestedByServiceId: SP,
      templateId: TEMPLATE_ID,
    });
    await h.app.close();
  });

  it('runs an allowlisted global template', async () => {
    s.templateTeamId = null;
    const h = harness(s);
    expect((await h.run()).statusCode).toBe(201);
    await h.app.close();
  });

  it('answers 404 for a template not on its allowlist, as for one that does not exist', async () => {
    s.templateIds = [];
    const h = harness(s);
    const res = await h.run();
    expect(res.statusCode).toBe(404);
    expect(h.started).toHaveLength(0);
    await h.app.close();
  });

  it("answers 404 for another team's template even when the allowlist names it", async () => {
    s.templateTeamId = OTHER_TEAM;
    const h = harness(s);
    expect((await h.run()).statusCode).toBe(404);
    await h.app.close();
  });

  it("refuses a connection-less run when its template team's org is over its cap", async () => {
    s.orgOverBudget = true;
    const h = harness(s);
    const res = await h.run();
    expect(res.statusCode).toBe(402);
    expect(h.started).toHaveLength(0);
    await h.app.close();
  });

  it('refuses at its daily limit, decided inside the ledger transaction', async () => {
    s.runsLastDay = 3;
    const h = harness(s);
    const res = await h.run();
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('SERVICE_DAILY_LIMIT_REACHED');
    expect(h.runInputs).toHaveLength(0);
    await h.app.close();
  });

  it('scopes an Idempotency-Key to the principal as well as the template', async () => {
    const h = harness(s);
    await h.run({ 'idempotency-key': 'k-1' });
    expect(h.started[0]).toMatch(/^wf-aaaaaaaa-s33333333-[0-9a-f]{16}$/);
    await h.app.close();
  });

  it('needs the runs:launch scope', async () => {
    const h = harness(s);
    // Swap the token for one carrying only runs:read.
    const prisma = h.app.prisma as unknown as { apiToken: { findUnique: () => Promise<unknown> } };
    const original = prisma.apiToken.findUnique;
    prisma.apiToken.findUnique = async () => ({
      ...((await original()) as Record<string, unknown>),
      scopes: ['runs:read'],
    });
    const res = await h.run();
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE');
    await h.app.close();
  });

  it('cannot reach any other template route', async () => {
    const h = harness(s);
    const res = await h.app.inject({
      headers: { authorization: 'Bearer ats_service' },
      method: 'GET',
      url: `/api/v1/workflow-templates/${TEMPLATE_ID}/runs`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    await h.app.close();
  });
});
