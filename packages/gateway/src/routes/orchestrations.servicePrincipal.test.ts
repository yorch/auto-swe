import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { mintOrchestrationToken } from '@auto-swe/shared/lib/orchestrationTokenKey';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A service principal's orchestration spawns a child through the REAL agent-run launcher and the
 * REAL `servicePrincipalLaunchGuard`, over a mocked database (the neighbouring
 * `agentRuns.servicePrincipal.test.ts` does the same for a direct launch). The other orchestration
 * route tests mock the launcher itself, so they cannot see what the per-spawn guards decide:
 * the allowlist re-check at each spawn, the in-flight and daily counts across the children, and a
 * principal disabled mid-orchestration.
 */

vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => true),
  resolveSettings: vi.fn(async () => ({
    'mcp.maxConcurrentRuns': 5,
    'mcp.writeCallsPerMinute': 100,
    'mcp.writeToolsEnabled': true,
    'repoAccess.mode': 'off',
    'repoAccess.staleAfterHours': 24,
    'workspace.agentRunMaxConcurrentGlobal': 10,
    'workspace.agentRunMaxConcurrentPerTeam': 10,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
    'workspace.egressPolicy': 'open',
    'workspace.setupEgressPolicy': 'inherit',
  })),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false, hosts: [] })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/systemConfig')>()),
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: async () => ({ mode: 'off', staleAfterHours: 0 }),
}));

import { __resetReconcileCacheForTests } from '@auto-swe/shared/lib/agentRunAdmission';
import { resetMcpWriteRateLimit } from '../lib/mcpWriteGuard.js';
import { _resetAuthCachesForTests } from '../plugins/auth.js';
import { buildAssistantApp } from '../test/assistantApp.js';
import { orchestrationRoutes } from './orchestrations.js';

const ORCH = '00000000-0000-4000-8000-0000000000f1';
const SP = '33333333-3333-4333-8333-333333333333';
const SP_TEAM = '22222222-2222-4222-8222-222222222222';
const ORG = '55555555-5555-4555-8555-555555555555';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TEMPLATE = 'cccccccc-1111-4111-8111-cccccccccccc';

interface PrincipalRow {
  connectionIds: string[];
  disabledAt: Date | null;
  maxInFlight: number;
  maxRunsPerDay: number;
  team: { isActive: boolean; organization: { isActive: boolean } };
  teamId: string;
}

describe('a service principal orchestration spawning writers through the real launcher', () => {
  let app: FastifyInstance;
  let admission: PrincipalRow;
  let guardRow: PrincipalRow;
  let guardRepoTeamId: string;
  let runInputs: Array<Record<string, unknown>>;
  let ledgers: Array<Record<string, unknown>>;
  let children: Array<Record<string, unknown>>;
  let started: Array<{ id: string; input: Record<string, unknown> }>;
  let locks: string[];

  beforeAll(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  beforeEach(async () => {
    __resetReconcileCacheForTests();
    _resetAuthCachesForTests();
    resetMcpWriteRateLimit();
    const base: PrincipalRow = {
      connectionIds: [REPO],
      disabledAt: null,
      maxInFlight: 2,
      maxRunsPerDay: 2,
      team: { isActive: true, organization: { isActive: true } },
      teamId: SP_TEAM,
    };
    admission = { ...base };
    guardRow = { ...base };
    guardRepoTeamId = SP_TEAM;
    runInputs = [];
    ledgers = [];
    children = [];
    started = [];
    locks = [];

    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        locks.push(strings.join('?'));
        return [{ id: 'locked' }];
      },
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        // The principal's in-flight count: every ledger row its launches wrote and nothing closed.
        count: async () => ledgers.length,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          ledgers.push(data);
          return { id: `aw-${ledgers.length}`, ...data };
        },
        delete: async () => ({}),
        findMany: async () => [],
        findUnique: async () => null,
        updateMany: async () => ({ count: 0 }),
      },
      agent: {
        findMany: async () => [{ mcpConnectionId: null, scope: 'GLOBAL', version: 1 }],
      },
      apiToken: { findFirst: async () => ({ id: 'tok' }) },
      configAuditLog: { create: async () => ({}) },
      connection: {
        findUnique: async ({
          include,
          select,
        }: {
          include?: Record<string, unknown>;
          select?: Record<string, unknown>;
        }) => {
          // The launch guard's narrow read under the connection lock.
          if (select && !('type' in select)) {
            return { isActive: true, shares: [], teamId: guardRepoTeamId };
          }
          void include;
          return {
            githubApiUrl: null,
            githubUrl: null,
            id: REPO,
            installation: null,
            isActive: true,
            organizationName: 'acme',
            repoName: 'api',
            shares: [],
            team: {
              memberships: [],
              organization: { id: ORG, monthlyBudgetUsdCents: null },
              orgId: ORG,
            },
            teamId: SP_TEAM,
            type: 'git_repo',
          };
        },
      },
      orchestration: {
        findFirst: async () => ({
          allowlist: ['writer'],
          budgetTier: 'STANDARD',
          connectionIds: [],
          deliveryDefault: 'draft_pr',
          id: ORCH,
          launchedById: null,
          orgId: ORG,
          repoId: REPO,
          serviceId: SP,
          status: 'ACTIVE',
          teamId: SP_TEAM,
          workRequest: {
            payload: {
              pinned: {
                maxChildren: 10,
                maxConcurrentChildren: 10,
                maxTurns: 200,
                maxWallClockSeconds: 3600,
                maxWriterChildren: 10,
              },
            },
          },
        }),
      },
      orchestrationChild: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          children.push(data);
          return data;
        },
        deleteMany: async () => ({ count: 0 }),
        findFirst: async () => null,
        findMany: async () =>
          children.map((c) => ({
            pathScopes: c.pathScopes,
            role: c.role,
            status: c.status,
          })),
        updateMany: async () => ({ count: 0 }),
      },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        // The principal's runs in the last day: every run input its launches wrote.
        count: async () => runInputs.length,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          runInputs.push(data);
          return data;
        },
        delete: async () => ({}),
        findUnique: async () => null,
      },
      servicePrincipal: {
        // Admission selects the principal's `id` and `name`; the launch guard does not. They read
        // separate rows so a principal disabled between the two can be told apart.
        findUnique: async ({ select }: { select: Record<string, unknown> }) =>
          'id' in select
            ? { ...admission, id: SP, name: 'ci', templateIds: [] }
            : { ...guardRow, templateIds: [] },
      },
      user: { findUnique: async () => null },
      workflowTemplate: { findFirst: async () => ({ activeVersion: 1, id: TEMPLATE }) },
    };
    app = await buildAssistantApp(prisma as never, async (a) => {
      a.decorate('temporal', {
        cancelWorkflow: async () => undefined,
        isWorkflowGone: async () => false,
        startRunnableWorkflow: async (id: string, input: Record<string, unknown>) => {
          started.push({ id, input });
        },
      } as never);
      await a.register(orchestrationRoutes, { prefix: '/api/v1/orchestrations' });
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const spawn = (turn: number, scope = `src/area${turn}/**`) =>
    app.inject({
      headers: { authorization: `Bearer ${mintOrchestrationToken({ orchestrationId: ORCH })}` },
      method: 'POST',
      payload: {
        intent: {
          agent: 'writer',
          deliver: 'draft_pr',
          label: `w${turn}`,
          pathScopes: [scope],
          role: 'writer',
          task: 'change it',
        },
        turnKey: `turn-${turn}`,
      },
      url: `/api/v1/orchestrations/${ORCH}/children`,
    });

  const codeOf = (res: { json: () => { code?: string; error?: { code?: string } } }) =>
    res.json().error?.code ?? res.json().code;

  it('starts a writer as the principal, on the platform credential, under its row lock', async () => {
    const res = await spawn(1);
    expect(res.statusCode, res.body).toBe(201);
    const request = started[0]?.input.request as Record<string, unknown>;
    expect(request).not.toHaveProperty('launchedById');
    expect(request).toMatchObject({ initiatedByServiceId: SP, trigger: 'service-token' });
    expect(runInputs[0]).toMatchObject({ requestedById: null, requestedByServiceId: SP });
    expect(children).toHaveLength(1);
    expect(locks.some((sql) => sql.includes('FROM service_principals'))).toBe(true);
  });

  it('counts the in-flight limit across its children: the third spawn is refused', async () => {
    guardRow.maxRunsPerDay = 10;
    expect((await spawn(1)).statusCode).toBe(201);
    expect((await spawn(2)).statusCode).toBe(201);
    const third = await spawn(3);
    expect(third.statusCode).toBe(429);
    expect(codeOf(third)).toBe('SERVICE_IN_FLIGHT_LIMIT_REACHED');
    expect(started).toHaveLength(2);
    expect(children).toHaveLength(2);
  });

  it('counts the daily limit across its children, even once they are no longer in flight', async () => {
    guardRow.maxInFlight = 10;
    expect((await spawn(1)).statusCode).toBe(201);
    expect((await spawn(2)).statusCode).toBe(201);
    const third = await spawn(3);
    expect(third.statusCode).toBe(429);
    expect(codeOf(third)).toBe('SERVICE_DAILY_LIMIT_REACHED');
    expect(started).toHaveLength(2);
  });

  it('re-checks the allowlist at every spawn: a repository taken off it ends the next spawn', async () => {
    expect((await spawn(1)).statusCode).toBe(201);
    // Edited after the first spawn: both what token admission reads and what the guard re-reads.
    admission.connectionIds = [];
    guardRow.connectionIds = [];
    const second = await spawn(2);
    expect(second.statusCode).toBe(404);
    expect(codeOf(second)).toBe('CONNECTION_NOT_FOUND');
    expect(started).toHaveLength(1);
    expect(children).toHaveLength(1);
  });

  it('decides an allowlist edit that lands after admission under the lock, on the spawn route', async () => {
    guardRow.connectionIds = [];
    const res = await spawn(1);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('SERVICE_CONNECTION_NOT_ALLOWED');
    expect(started).toHaveLength(0);
    expect(children).toHaveLength(0);
    expect(runInputs).toHaveLength(0);
  });

  it('refuses once its team lost the repository, under the lock', async () => {
    guardRepoTeamId = '44444444-4444-4444-8444-444444444444';
    const res = await spawn(1);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('SERVICE_CONNECTION_NOT_ALLOWED');
    expect(started).toHaveLength(0);
  });

  it('refuses a principal disabled mid-orchestration, on the spawn route itself', async () => {
    expect((await spawn(1)).statusCode).toBe(201);
    // Disabled after admission read it: the launch guard under the principal's lock decides.
    guardRow.disabledAt = new Date();
    const res = await spawn(2);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('SERVICE_PRINCIPAL_DISABLED');
    expect(started).toHaveLength(1);
    expect(children).toHaveLength(1);
  });

  it('refuses at admission when the principal was disabled before the request', async () => {
    admission.disabledAt = new Date();
    const res = await spawn(1);
    expect(res.statusCode).toBe(401);
    expect(started).toHaveLength(0);
  });
});
