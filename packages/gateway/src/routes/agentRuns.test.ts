import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  hostsOk: true,
  settings: {
    // The request's repo-access gate is resolved from the same registry.
    'repoAccess.mode': 'off',
    'repoAccess.staleAfterHours': 24,
    'workspace.agentRunMaxConcurrentGlobal': 4,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
    'workspace.agentRunMaxSteps': 50,
    'workspace.agentRunMaxWallClockSeconds': 1800,
  } as Record<string, number | string>,
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: vi.fn(async () => cfg.settings) }));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () =>
    cfg.hostsOk ? { ok: true } : { ok: false, url: 'https://evil.example' }
  ),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false, hosts: [] })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));

import { __resetReconcileCacheForTests } from '@auto-swe/shared/lib/agentRunAdmission';
import { agentRunRoutes } from './agentRuns.js';

const USER = 'user-1';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TEMPLATE = 'tttttttt-1111-4111-8111-tttttttttttt';
const PREV_RUN = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

interface State {
  /** Who is a member of the owning team / a shared team. */
  ownerMembers: string[];
  sharedMembers: string[];
  role: string;
  installationActive: boolean;
  agents: Array<{ scope: string; version: number }>;
  templateInstalled: boolean;
  inFlight: Array<{ teamId: string; workflowId: string }>;
  /** Per workflow id: `finished` or `down`; anything else is running. */
  temporal: Record<string, 'finished' | 'down'>;
  closed: string[][];
  startFails: boolean;
  type: string;
  prevRun: unknown;
  prevTemplateOk: boolean;
  orgOverBudget: boolean;
}

describe('POST /api/v1/agent-runs', () => {
  let app: FastifyInstance;
  let s: State;
  let events: string[];
  let runInputs: Array<Record<string, unknown>>;
  let ledgers: Array<Record<string, unknown>>;
  let started: Array<{ id: string; input: Record<string, unknown> }>;
  let agentQueries: Array<Record<string, unknown>>;

  beforeEach(async () => {
    __resetReconcileCacheForTests();
    cfg.hostsOk = true;
    cfg.settings['workspace.agentRunMaxConcurrentGlobal'] = 4;
    cfg.settings['workspace.agentRunMaxConcurrentPerTeam'] = 2;
    cfg.settings['workspace.agentRunMaxSteps'] = 50;
    cfg.settings['workspace.agentRunMaxWallClockSeconds'] = 1800;
    s = {
      agents: [{ scope: 'GLOBAL', version: 3 }],
      closed: [],
      inFlight: [],
      installationActive: true,
      orgOverBudget: false,
      ownerMembers: [USER],
      prevRun: null,
      prevTemplateOk: true,
      role: 'ENGINEER',
      sharedMembers: [],
      startFails: false,
      templateInstalled: true,
      temporal: {},
      type: 'git_repo',
    };
    events = [];
    runInputs = [];
    ledgers = [];
    started = [];
    agentQueries = [];

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: s.role, sub: USER }),
    } as unknown as never);

    const prisma = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push('ledger');
          ledgers.push(data);
          return { id: 'aw-1', ...data };
        },
        delete: async () => {
          events.push('ledger-deleted');
          return {};
        },
        findMany: async () =>
          s.inFlight.map((r) => ({
            currentStatus: 'IMPLEMENTING',
            repository: { teamId: r.teamId },
            temporalWorkflowId: r.workflowId,
            workRequest: { createdAt: new Date(1) },
          })),
        updateMany: async (args: { where: { temporalWorkflowId: { in: string[] } } }) => {
          s.closed.push(args.where.temporalWorkflowId.in);
          return { count: args.where.temporalWorkflowId.in.length };
        },
      },
      agent: {
        findMany: async (args: Record<string, unknown>) => {
          agentQueries.push(args);
          return s.agents;
        },
      },
      connection: {
        findUnique: async () => ({
          githubApiUrl: null,
          githubUrl: null,
          id: REPO,
          installation: s.installationActive
            ? { installationId: 1, isActive: true }
            : { installationId: 1, isActive: false },
          isActive: true,
          organizationName: 'acme',
          repoName: 'api',
          shares: s.sharedMembers.length
            ? [{ team: { memberships: s.sharedMembers.map((userId) => ({ userId })) } }]
            : [],
          team: {
            memberships: s.ownerMembers.map((userId) => ({ userId })),
            organization: { id: 'org-1', monthlyBudgetUsdCents: s.orgOverBudget ? 100 : null },
            orgId: 'org-1',
          },
          teamId: 'team-1',
          type: s.type,
        }),
      },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
      orgMonthlyUsage: {
        findUnique: async () => (s.orgOverBudget ? { costUsdAccrued: 100 } : null),
      },
      runInput: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          events.push('runInput');
          runInputs.push(data);
          return { id: data.id, ...data };
        },
        findUnique: async () => s.prevRun,
      },
      workflowTemplate: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id !== undefined) {
            return s.prevTemplateOk ? { id: TEMPLATE } : null;
          }
          return s.templateInstalled ? { activeVersion: 2, id: TEMPLATE } : null;
        },
      },
    };
    app.decorate(
      'prisma',
      new Proxy(prisma, {
        get: (t, prop) => {
          if (
            !(prop in t) &&
            typeof prop === 'string' &&
            !['getter', 'setter', 'then'].includes(prop)
          ) {
            throw new Error(`test prisma mock has no ${prop}`);
          }
          return (t as Record<string | symbol, unknown>)[prop];
        },
      }) as unknown as never
    );
    app.decorate('temporal', {
      isWorkflowGone: async (id: string) => {
        if (s.temporal[id] === 'down') {
          throw new Error('temporal unreachable');
        }
        return s.temporal[id] === 'finished';
      },
      startRunnableWorkflow: async (id: string, input: Record<string, unknown>) => {
        events.push('start');
        if (s.startFails) {
          throw new Error('temporal down');
        }
        started.push({ id, input });
      },
    } as unknown as never);
    app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
    await app.ready();
  });

  afterEach(() => app.close());

  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      headers: { authorization: 'Bearer t', ...headers },
      method: 'POST',
      payload: { agent: 'contentWriter', prompt: 'fix the typo', repoId: REPO, ...payload },
      url: '/api/v1/agent-runs',
    });

  it('launches: ledger and run input are written BEFORE the workflow starts', async () => {
    const res = await post({});
    expect(res.statusCode).toBe(201);
    expect(events).toEqual(['runInput', 'ledger', 'start']);
    const body = res.json().data;
    expect(body.effective).toEqual({ deliver: 'none', maxSteps: 50, maxWallClockSeconds: 1800 });
    expect(started[0]?.id).toMatch(/^agent-aaaaaaaa-[0-9a-f]{32}$/);
    const req = started[0]?.input.request as Record<string, unknown>;
    expect(req).toMatchObject({
      description: 'fix the typo',
      launchedById: USER,
      payload: { agentRef: 'contentWriter', deliver: 'none' },
      repoId: REPO,
    });
    expect(req.externalTicketId).toMatch(/^agent-[0-9a-f]{32}$/);
    // The ledger row carries the repo: the worker derives team and org from it.
    expect(ledgers[0]).toMatchObject({ currentStatus: 'IMPLEMENTING', repoId: REPO });
    expect(runInputs[0]).toMatchObject({ requestedById: USER, templateId: TEMPLATE });
  });

  it('assigns a branch only when the run delivers', async () => {
    await post({ deliver: 'branch' });
    expect(ledgers[0]?.assignedBranch).toMatch(/^auto\/agent-[0-9a-f]{32}$/);
    ledgers.length = 0;
    await post({});
    expect(ledgers[0]?.assignedBranch).toBeNull();
  });

  describe('trust: who may launch', () => {
    it('refuses a user who is not a member of the owning or a shared team', async () => {
      s.ownerMembers = ['someone-else'];
      const res = await post({});
      expect(res.statusCode).toBe(403);
      expect(events).toEqual([]);
    });

    it('accepts a member of a team the repository is SHARED with', async () => {
      s.ownerMembers = [];
      s.sharedMembers = [USER];
      expect((await post({})).statusCode).toBe(201);
    });

    it('resolves the agent at GLOBAL and the repo ORGANIZATION scope only (never the owning team)', async () => {
      s.ownerMembers = [];
      s.sharedMembers = [USER];
      await post({});
      const where = agentQueries[0]?.where as { OR: Array<Record<string, unknown>> };
      expect(where.OR).toEqual([
        { channelId: null, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
        { orgId: 'org-1', scope: 'ORGANIZATION' },
      ]);
      expect(JSON.stringify(where)).not.toContain('TEAM');
    });

    it('refuses a retired installation', async () => {
      s.installationActive = false;
      expect((await post({})).statusCode).toBe(409);
    });

    it('refuses a disallowed repository host', async () => {
      cfg.hostsOk = false;
      const res = await post({});
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('REPO_HOST_NOT_ALLOWED');
    });

    it('refuses a non-git connection', async () => {
      s.type = 'notion';
      expect((await post({})).statusCode).toBe(400);
    });

    it('refuses when the org is over budget', async () => {
      s.orgOverBudget = true;
      expect((await post({})).statusCode).toBe(402);
      expect(events).toEqual([]);
    });
  });

  describe('agent selection', () => {
    it.each(['securityReview', 'evalJudge', 'workflowAuthor', 'commitToMemory'])(
      'refuses the platform agent %s',
      async (agent) => {
        const res = await post({ agent });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('AGENT_NOT_LAUNCHABLE');
        expect(events).toEqual([]);
      }
    );

    it('404s an agent with no active row at an eligible scope', async () => {
      s.agents = [];
      const res = await post({});
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('AGENT_NOT_FOUND');
    });

    it('a pin must name an existing GLOBAL version', async () => {
      expect((await post({ agent: 'contentWriter@3' })).statusCode).toBe(201);
      expect((await post({ agent: 'contentWriter@9' })).statusCode).toBe(404);
      // An ORGANIZATION row cannot satisfy a pin: the pin applies to the GLOBAL lineage.
      s.agents = [{ scope: 'ORGANIZATION', version: 9 }];
      expect((await post({ agent: 'contentWriter@9' })).statusCode).toBe(404);
    });

    it('refuses a pin when an active ORGANIZATION override would shadow it', async () => {
      s.agents = [
        { scope: 'GLOBAL', version: 3 },
        { scope: 'ORGANIZATION', version: 9 },
      ];
      const pinned = await post({ agent: 'contentWriter@3' });
      expect(pinned.statusCode).toBe(400);
      expect(pinned.json().error.code).toBe('AGENT_PIN_SHADOWED');
      // Unpinned, the override is what runs, and that is fine.
      expect((await post({ agent: 'contentWriter' })).statusCode).toBe(201);
    });

    it('rejects a malformed agent reference', async () => {
      expect((await post({ agent: 'a b' })).statusCode).toBe(400);
      expect((await post({ agent: 'a@0' })).statusCode).toBe(400);
    });
  });

  describe('bounds', () => {
    it('rejects a cap above the platform ceiling, and echoes the ceiling', async () => {
      cfg.settings['workspace.agentRunMaxSteps'] = 30;
      const res = await post({ maxSteps: 31 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CAP_EXCEEDS_CEILING');
      expect(res.json().error.message).toContain('30');
      cfg.settings['workspace.agentRunMaxWallClockSeconds'] = 600;
      expect((await post({ maxWallClockSeconds: 601 })).json().error.code).toBe(
        'CAP_EXCEEDS_CEILING'
      );
      expect(events).toEqual([]);
    });

    it('lets a launch lower a ceiling and reports the effective values', async () => {
      const res = await post({ maxSteps: 5, maxWallClockSeconds: 120 });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.effective).toMatchObject({ maxSteps: 5, maxWallClockSeconds: 120 });
      expect(started[0]?.input.request).toMatchObject({
        payload: { maxSteps: 5, maxWallClockSeconds: 120 },
      });
    });
  });

  describe('concurrency', () => {
    it('429s a launch past the per-team limit', async () => {
      s.inFlight = [
        { teamId: 'team-1', workflowId: 'w1' },
        { teamId: 'team-1', workflowId: 'w2' },
      ];
      const res = await post({});
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('AGENT_RUN_CONCURRENCY_EXCEEDED');
      expect(events).toEqual([]);
    });

    it('admits a launch once the runs holding the slots are gone from Temporal, and closes them', async () => {
      s.inFlight = [
        { teamId: 'team-1', workflowId: 'w1' },
        { teamId: 'team-1', workflowId: 'w2' },
      ];
      s.temporal = { w1: 'finished', w2: 'finished' };
      const res = await post({});
      expect(res.statusCode).toBe(201);
      expect(s.closed).toEqual([['w1', 'w2']]);
    });

    it('keeps counting runs that are still running in Temporal', async () => {
      s.inFlight = [
        { teamId: 'team-1', workflowId: 'w1' },
        { teamId: 'team-1', workflowId: 'w2' },
      ];
      expect((await post({})).statusCode).toBe(429);
      expect(s.closed).toEqual([]);
    });

    it('does not free a slot when Temporal cannot be reached', async () => {
      s.inFlight = [
        { teamId: 'team-1', workflowId: 'w1' },
        { teamId: 'team-1', workflowId: 'w2' },
      ];
      s.temporal = { w1: 'down', w2: 'down' };
      expect((await post({})).statusCode).toBe(429);
      expect(s.closed).toEqual([]);
    });

    it('429s a launch past the platform limit even when the team has room', async () => {
      cfg.settings['workspace.agentRunMaxConcurrentGlobal'] = 2;
      s.inFlight = [
        { teamId: 'other-1', workflowId: 'w1' },
        { teamId: 'other-2', workflowId: 'w2' },
      ];
      expect((await post({})).statusCode).toBe(429);
    });

    it('403s when agent runs are disabled (0)', async () => {
      cfg.settings['workspace.agentRunMaxConcurrentPerTeam'] = 0;
      const res = await post({});
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('AGENT_RUNS_DISABLED');
    });
  });

  it('503s with a clear message when the system template is not installed', async () => {
    s.templateInstalled = false;
    const res = await post({});
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AGENT_RUN_TEMPLATE_MISSING');
  });

  it('rolls the ledger back when the workflow fails to start', async () => {
    s.startFails = true;
    const res = await post({});
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(events).toContain('ledger-deleted');
  });

  describe('Idempotency-Key', () => {
    it('derives the workflow id from the key, scoped to repo AND caller', async () => {
      await post({}, { 'idempotency-key': 'k1' });
      await post({}, { 'idempotency-key': 'k1' });
      await post({}, { 'idempotency-key': 'k2' });
      const [a, b, c] = started.map((x) => x.id);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      // `agent-<repo8>-<user8>-<digest>`: the caller is part of the scope.
      expect(a).toMatch(/^agent-aaaaaaaa-user1-?/);
    });
  });
});

describe('POST /api/v1/agent-runs/:id/rerun', () => {
  // The shared pipeline is covered above; these pin what is specific to a re-run.
  async function build(prev: unknown, templateOk = true) {
    const started: Array<{ id: string; input: Record<string, unknown> }> = [];
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-2' }),
    } as unknown as never);
    const prisma = {
      $transaction: async (arg: unknown) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[]),
      activeWorkflow: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aw-2', ...data }),
        delete: async () => ({}),
        findMany: async () => [],
      },
      agent: { findMany: async () => [{ scope: 'GLOBAL', version: 1 }] },
      connection: {
        findUnique: async () => ({
          githubApiUrl: null,
          githubUrl: null,
          id: REPO,
          installation: null,
          isActive: true,
          organizationName: 'acme',
          repoName: 'api',
          shares: [],
          team: {
            memberships: [{ userId: 'user-2' }],
            organization: { id: 'org-1', monthlyBudgetUsdCents: null },
            orgId: 'org-1',
          },
          teamId: 'team-1',
          type: 'git_repo',
        }),
      },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id, ...data }),
        findUnique: async () => prev,
      },
      workflowTemplate: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          where.id !== undefined
            ? templateOk
              ? { id: TEMPLATE }
              : null
            : { activeVersion: 2, id: TEMPLATE },
      },
    };
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('temporal', {
      startRunnableWorkflow: async (id: string, input: Record<string, unknown>) => {
        started.push({ id, input });
      },
    } as unknown as never);
    app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
    await app.ready();
    return { app, started };
  }

  const prevRun = {
    connectionId: REPO,
    description: 'original prompt',
    payload: { agentRef: 'contentWriter', deliver: 'branch', maxSteps: 7 },
    templateId: TEMPLATE,
  };

  it('starts a NEW run (new ticket id and branch) as the re-runner, with the stored parameters', async () => {
    const { app, started } = await build(prevRun);
    const res = await app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      url: `/api/v1/agent-runs/${PREV_RUN}/rerun`,
    });
    expect(res.statusCode).toBe(201);
    const req = started[0]?.input.request as Record<string, unknown>;
    expect(req.workRequestId).not.toBe(PREV_RUN);
    expect(req.externalTicketId).toMatch(/^agent-[0-9a-f]{32}$/);
    expect(req).toMatchObject({
      description: 'original prompt',
      launchedById: 'user-2',
      payload: { agentRef: 'contentWriter', deliver: 'branch', maxSteps: 7 },
    });
    await app.close();
  });

  it('404s a work request that is not an agent run, or has no usable payload', async () => {
    for (const [prev, templateOk] of [
      [null, true],
      [prevRun, false],
      [{ ...prevRun, payload: { nope: true } }, true],
      [{ ...prevRun, connectionId: null }, true],
    ] as const) {
      const { app } = await build(prev, templateOk);
      const res = await app.inject({
        headers: { authorization: 'Bearer t' },
        method: 'POST',
        url: `/api/v1/agent-runs/${PREV_RUN}/rerun`,
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    }
  });
});
