import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `POST /api/v1/agent-runs` launched with a service principal's token: the launch authorization
 * matrix (scope, allowlist, team reach, org cap), the principal's own limits decided inside the
 * ledger transaction, attribution, and Idempotency-Key scoping.
 */

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSettings: vi.fn(async () => ({
    'repoAccess.mode': 'off',
    'repoAccess.staleAfterHours': 24,
    'workspace.agentRunMaxConcurrentGlobal': 10,
    'workspace.agentRunMaxConcurrentPerTeam': 10,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
  })),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false, hosts: [] })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));

import { __resetReconcileCacheForTests } from '@auto-swe/shared/lib/agentRunAdmission';
import { agentRunRoutes } from './agentRuns.js';

const USER = '11111111-1111-4111-8111-111111111111';
const SP = '33333333-3333-4333-8333-333333333333';
const SP_TEAM = '22222222-2222-4222-8222-222222222222';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TEMPLATE = 'cccccccc-1111-4111-8111-cccccccccccc';

interface State {
  scopes: string[];
  /** The allowlist the token's request loads. */
  connectionIds: string[];
  /** The principal row as the launch guard re-reads it under the lock. */
  guardRow: {
    connectionIds: string[];
    disabledAt: Date | null;
    maxInFlight: number;
    maxRunsPerDay: number;
    team: { isActive: boolean };
    templateIds: string[];
  } | null;
  repoTeamId: string;
  sharedWith: string[];
  orgOverBudget: boolean;
  runsLastDay: number;
  inFlight: number;
}

describe('POST /api/v1/agent-runs with a service principal token', () => {
  let app: FastifyInstance;
  let s: State;
  let runInputs: Array<Record<string, unknown>>;
  let started: Array<{ id: string; input: Record<string, unknown> }>;
  let locks: string[];

  beforeEach(async () => {
    __resetReconcileCacheForTests();
    s = {
      connectionIds: [REPO],
      guardRow: {
        connectionIds: [REPO],
        disabledAt: null,
        maxInFlight: 5,
        maxRunsPerDay: 50,
        team: { isActive: true },
        templateIds: [],
      },
      inFlight: 0,
      orgOverBudget: false,
      repoTeamId: SP_TEAM,
      runsLastDay: 0,
      scopes: ['runs:launch'],
      sharedWith: [],
    };
    runInputs = [];
    started = [];
    locks = [];

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      hashToken: (t: string) => `hash:${t}`,
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: USER }),
    } as unknown as never);

    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        locks.push(strings.join('?'));
        return [{ id: 'locked' }];
      },
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        count: async () => s.inFlight,
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aw-1', ...data }),
        delete: async () => ({}),
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
      },
      agent: { findMany: async () => [{ scope: 'GLOBAL', version: 1 }] },
      apiToken: {
        findUnique: async ({ where }: { where: { tokenHash: string } }) =>
          where.tokenHash === 'hash:ats_service'
            ? {
                expiresAt: new Date(Date.now() + 86_400_000),
                id: 'tok-1',
                revokedAt: null,
                scopes: s.scopes,
                servicePrincipal: {
                  connectionIds: s.connectionIds,
                  disabledAt: null,
                  id: SP,
                  name: 'deployer',
                  team: { isActive: true, organization: { isActive: true } },
                  teamId: SP_TEAM,
                  templateIds: [],
                },
                servicePrincipalId: SP,
                user: null,
                userId: null,
              }
            : null,
        update: async () => ({}),
      },
      connection: {
        findUnique: async () => ({
          githubApiUrl: null,
          githubUrl: null,
          id: REPO,
          installation: null,
          isActive: true,
          organizationName: 'acme',
          repoName: 'api',
          shares: s.sharedWith.map((teamId) => ({
            team: { isActive: true, memberships: [] },
            teamId,
          })),
          team: {
            memberships: [{ userId: USER }],
            organization: { id: 'org-1', monthlyBudgetUsdCents: s.orgOverBudget ? 100 : null },
            orgId: 'org-1',
          },
          teamId: s.repoTeamId,
          type: 'git_repo',
        }),
      },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
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
        findUnique: async () => null,
      },
      servicePrincipal: { findUnique: async () => s.guardRow },
      user: { findUnique: async () => ({ id: USER, isActive: true, role: 'ENGINEER' }) },
      workflowTemplate: {
        findFirst: async () => ({ activeVersion: 1, id: TEMPLATE }),
      },
    };
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('temporal', {
      isWorkflowGone: async () => false,
      startRunnableWorkflow: async (id: string, input: Record<string, unknown>) => {
        started.push({ id, input });
      },
    } as unknown as never);
    app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
    await app.ready();
  });

  afterEach(() => app.close());

  const post = (headers: Record<string, string> = {}, token = 'ats_service') =>
    app.inject({
      headers: { authorization: `Bearer ${token}`, ...headers },
      method: 'POST',
      payload: { agent: 'contentWriter', prompt: 'bump the version', repoId: REPO },
      url: '/api/v1/agent-runs',
    });

  it('launches on an allowlisted repository of its team, attributed to the principal', async () => {
    const res = await post();
    expect(res.statusCode).toBe(201);
    const request = started[0]?.input.request as Record<string, unknown>;
    // The platform credential: no launcher for the worker to act as.
    expect(request).not.toHaveProperty('launchedById');
    expect(runInputs[0]).toMatchObject({ requestedById: null, requestedByServiceId: SP });
    // The launch took the principal's row lock inside the ledger transaction.
    expect(locks.some((sql) => sql.includes('FROM service_principals'))).toBe(true);
  });

  it('launches on a repository shared with its team', async () => {
    s.repoTeamId = OTHER_TEAM;
    s.sharedWith = [SP_TEAM];
    expect((await post()).statusCode).toBe(201);
  });

  describe('refusals', () => {
    it('without the runs:launch scope: 403 INSUFFICIENT_SCOPE', async () => {
      s.scopes = ['runs:read'];
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('INSUFFICIENT_SCOPE');
      expect(started).toHaveLength(0);
    });

    it('a repository not on its allowlist', async () => {
      s.connectionIds = [];
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SERVICE_CONNECTION_NOT_ALLOWED');
      expect(runInputs).toHaveLength(0);
    });

    it('an allowlisted repository its team neither owns nor shares', async () => {
      s.repoTeamId = OTHER_TEAM;
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SERVICE_CONNECTION_NOT_ALLOWED');
      expect(runInputs).toHaveLength(0);
    });

    it('an org over its monthly cap: 402', async () => {
      s.orgOverBudget = true;
      const res = await post();
      expect(res.statusCode).toBe(402);
      expect(res.json().error.code).toBe('ORG_BUDGET_EXCEEDED');
    });

    it('a principal disabled after its token was checked, decided under the lock', async () => {
      s.guardRow = { ...(s.guardRow as NonNullable<State['guardRow']>), disabledAt: new Date() };
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SERVICE_PRINCIPAL_DISABLED');
      expect(runInputs).toHaveLength(0);
      expect(started).toHaveLength(0);
    });

    it('a repository taken off the allowlist after the token was checked', async () => {
      s.guardRow = { ...(s.guardRow as NonNullable<State['guardRow']>), connectionIds: [] };
      const res = await post();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SERVICE_CONNECTION_NOT_ALLOWED');
      expect(runInputs).toHaveLength(0);
    });

    it('its daily limit reached: 429, nothing written', async () => {
      s.runsLastDay = 50;
      const res = await post();
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('SERVICE_DAILY_LIMIT_REACHED');
      expect(runInputs).toHaveLength(0);
      expect(started).toHaveLength(0);
    });

    it('its in-flight limit reached: 429, nothing written', async () => {
      s.inFlight = 5;
      const res = await post();
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('SERVICE_IN_FLIGHT_LIMIT_REACHED');
      expect(started).toHaveLength(0);
    });

    it('a re-run: the route does not admit service tokens', async () => {
      const res = await app.inject({
        headers: { authorization: 'Bearer ats_service' },
        method: 'POST',
        url: `/api/v1/agent-runs/${REPO}/rerun`,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('SERVICE_TOKEN_NOT_ALLOWED');
    });

    it('the launch-form reads: not opted in', async () => {
      const res = await app.inject({
        headers: { authorization: 'Bearer ats_service' },
        method: 'GET',
        url: '/api/v1/agent-runs/agents',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('Idempotency-Key', () => {
    it("is scoped to the principal: its key never names a person's run", async () => {
      await post({ 'idempotency-key': 'deploy-42' });
      await post({ 'idempotency-key': 'deploy-42' }, 'fake-jwt');
      const [service, person] = started.map((x) => x.id);
      expect(service).toMatch(/^agent-aaaaaaaa-s33333333-[0-9a-f]{16}$/);
      expect(person).toMatch(/^agent-aaaaaaaa-11111111-[0-9a-f]{16}$/);
    });

    it('derives the same workflow id for a retry of the same key by the same principal', async () => {
      await post({ 'idempotency-key': 'deploy-42' });
      await post({ 'idempotency-key': 'deploy-42' });
      expect(started[0]?.id).toBe(started[1]?.id);
    });
  });
});
