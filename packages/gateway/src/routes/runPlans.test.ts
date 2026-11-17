import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => 'open'),
  resolveSettings: vi.fn(async () => ({ ...cfg.settings })),
  snapshotPinnedSettings: vi.fn(async () => ({ 'workflow.maxTransitions': 500 })),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () =>
    hostState.ok ? { ok: true } : { ok: false, url: 'https://evil.example' }
  ),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false, hosts: [] })),
}));
const hostState = vi.hoisted(() => ({ ok: true }));
const m = vi.hoisted(() => ({
  approve: vi.fn(),
  create: vi.fn(),
  validate: vi.fn(),
}));
vi.mock('../lib/runConnection.js', () => ({ validateRunConnection: m.validate }));
vi.mock('../lib/runPlanService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/runPlanService.js')>()),
  approveAndLaunchPlan: m.approve,
  createPlanRecord: m.create,
}));

import { planIdForJob, runPlanRoutes } from './runPlans.js';

const USER = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = '9f8e7d6c-2222-4222-8222-bbbbbbbbbbbb';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PLAN = '0b1c2d3e-0000-4000-8000-000000000001';
const SECRET_INTENT = 'ship the zebra-migration-7731 hotfix';

const DEFAULT_SETTINGS = {
  'runPlans.createPerUserPerHour': 10,
  'runPlans.enabled': true,
  'runPlans.maxPendingPerUser': 5,
  'runPlans.routePerUserPerHour': 30,
};

interface Row extends Record<string, unknown> {
  id: string;
  ownerUserId: string;
}

/** What `m.create` is called with: the fields these tests read. */
interface CreateInput {
  agentKey: unknown;
  agentPins: unknown;
  connectionId: string;
  costEstimate: unknown;
  id: string;
  intent: string;
  mode: string;
  model: string;
  owner: { sub: string };
  routerCandidates: unknown;
  spec: unknown;
}

/** The comparison operators the fake tables understand. */
interface Cond {
  equals?: unknown;
  gt?: Date;
  in?: unknown[];
}
const cond = (v: unknown) => v as Cond;
const eventOf = (a: { data: Record<string, unknown> }) =>
  (a.data.afterJson as { event?: string }).event;
const whereOf = (query: unknown) => (query as { where: Record<string, unknown> }).where;

interface State {
  role: string;
  active: boolean;
  reach: boolean;
  agents: Array<{ key: string }>;
  templates: Array<Record<string, unknown>>;
  plans: Row[];
  audit: Array<{ data: Record<string, unknown> }>;
  jobs: Map<string, unknown>;
  started: Array<{ id: string; input: Record<string, unknown>; memo: Record<string, unknown> }>;
  startResult: { started: boolean };
  startThrows: boolean;
  routed: Array<{
    id: string;
    input: { candidates: Array<{ id: string }>; maxResults: number };
  }>;
  routeResult: unknown;
  routeThrows: boolean;
  queries: { templates: Array<Record<string, unknown>>; agents: Array<Record<string, unknown>> };
  raceOnCreate: boolean;
  launched: boolean;
}

describe('run plan routes', () => {
  let app: FastifyInstance;
  let s: State;
  const logs: string[] = [];
  let routeConfigs: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    for (const k of Object.keys(cfg.settings)) {
      delete cfg.settings[k];
    }
    Object.assign(cfg.settings, DEFAULT_SETTINGS);
    hostState.ok = true;
    m.approve.mockReset();
    m.create.mockReset();
    m.validate.mockReset();
    logs.length = 0;
    s = {
      active: true,
      agents: [{ key: 'contentWriter' }, { key: 'docsMaintainer' }],
      audit: [],
      jobs: new Map(),
      launched: false,
      plans: [],
      queries: { agents: [], templates: [] },
      raceOnCreate: false,
      reach: true,
      role: 'ENGINEER',
      routed: [],
      routeResult: { matches: [], noneFit: true },
      routeThrows: false,
      started: [],
      startResult: { started: true },
      startThrows: false,
      templates: [
        {
          description: 'Ship a ticket',
          id: 't-1',
          kind: null,
          name: 'Ticket to merge',
          teamId: null,
        },
        { description: 'Docs sweep', id: 't-2', kind: null, name: 'Docs', teamId: 'team-1' },
        { description: 'Review', id: 't-3', kind: 'review', name: 'Review', teamId: null },
        { description: 'Chan', id: 't-4', kind: null, name: 'Channel Assistant', teamId: null },
        { description: 'Planned', id: 't-5', kind: null, name: 'Planned Run', teamId: null },
      ],
    };
    // A validator that sends what the real one would for a repository the caller cannot reach.
    m.validate.mockImplementation(
      async (
        _input: unknown,
        reply: { status: (code: number) => { send: (body: unknown) => void } }
      ) => {
        if (!s.reach) {
          reply.status(404).send({
            error: { code: 'CONNECTION_NOT_FOUND', message: 'Connection not found or inactive' },
          });
          return { ok: false };
        }
        return { ok: true };
      }
    );
    m.create.mockImplementation(async (_deps: unknown, input: CreateInput) => {
      if (s.raceOnCreate) {
        s.plans.push({ id: input.id, ownerUserId: input.owner.sub });
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      s.plans.push({
        agentKey: input.agentKey,
        agentPins: input.agentPins,
        approvedAt: null,
        connectionId: input.connectionId,
        costEstimate: input.costEstimate,
        createdAt: new Date('2026-11-17T12:00:00Z'),
        expiresAt: new Date('2026-11-17T12:30:00Z'),
        id: input.id,
        intent: input.intent,
        launchedWorkflowRunId: null,
        mode: input.mode,
        model: input.model,
        ownerUserId: input.owner.sub,
        routerCandidates: input.routerCandidates,
        skeletonReport: {
          mandatory: { implementation: ['implement'] },
          regions: { core: ['implement'], post: [], pre: ['gather'] },
          warnings: [{ code: 'W1', message: 'careful', nodeId: 'gather' }],
        },
        spec: input.spec,
        specHash: 'h',
        status: 'PENDING',
        teamId: 'team-1',
        validationReport: { errors: [], warnings: [] },
      });
      return { expiresAt: new Date(), ok: true, planId: input.id };
    });

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: s.role, sub: USER }),
    } as unknown as never);
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-principal']) {
        (request as unknown as { principal: unknown }).principal = {
          scopes: [],
          servicePrincipalId: 'sp-1',
        };
      }
    });

    const matches = (row: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => {
        const c = cond(v);
        if (v && typeof v === 'object' && c.in) {
          return c.in.includes(row[k]);
        }
        if (v && typeof v === 'object' && c.gt) {
          return (row[k] as Date) > c.gt;
        }
        return row[k] === v;
      });
    const prisma: Record<string, unknown> = {
      $executeRaw: async () => 1,
      $transaction: async (arg: unknown) =>
        typeof arg === 'function'
          ? (arg as (p: unknown) => unknown)(prisma)
          : Promise.all(arg as Promise<unknown>[]),
      agent: {
        findMany: async (args: Record<string, unknown>) => {
          s.queries.agents.push(args);
          return s.agents;
        },
      },
      configAuditLog: {
        count: async ({ where }: { where: Record<string, unknown> }) =>
          s.audit.filter(
            (a) => a.data.actorId === where.actorId && eventOf(a) === cond(where.afterJson).equals
          ).length,
        create: async (args: { data: Record<string, unknown> }) => {
          s.audit.push(args);
          return {};
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          const before = s.audit.length;
          s.audit = s.audit.filter(
            (a) =>
              !(eventOf(a) === cond(where.afterJson).equals && a.data.entityId === where.entityId)
          );
          return { count: before - s.audit.length };
        },
      },
      connection: {
        findUnique: async () => ({
          githubApiUrl: null,
          githubUrl: null,
          id: REPO,
          organizationName: 'acme',
          repoName: 'api',
          team: { orgId: 'org-1' },
          teamId: 'team-1',
          type: 'git_repo',
        }),
      },
      runInput: {
        findFirst: async () => (s.launched ? { id: 'wr-1' } : null),
      },
      runPlan: {
        count: async ({ where }: { where: Record<string, unknown> }) =>
          s.plans.filter((p) => matches(p, where)).length,
        findMany: async ({
          skip,
          take,
          where,
        }: {
          skip: number;
          take: number;
          where: Record<string, unknown>;
        }) => s.plans.filter((p) => matches(p, where)).slice(skip, skip + take),
        findUnique: async ({ where }: { where: { id: string } }) =>
          s.plans.find((p) => p.id === where.id) ?? null,
        updateMany: async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          const hit = s.plans.filter((p) => matches(p, where));
          for (const p of hit) {
            Object.assign(p, data);
          }
          return { count: hit.length };
        },
      },
      team: { findUnique: async () => ({ orgId: 'org-1' }) },
      user: {
        findUnique: async () => ({ id: USER, isActive: s.active, role: s.role }),
      },
      workflowTemplate: {
        findFirst: async () => ({ activeVersion: 1, id: 'tpl-planned' }),
        findMany: async (args: Record<string, unknown>) => {
          s.queries.templates.push(args);
          return s.templates;
        },
      },
    };
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('temporal', {
      getRunPlanJob: async (id: string) => s.jobs.get(id) ?? { status: 'not_found' },
      isWorkflowGone: async () => true,
      routeRunPlan: async (id: string, input: State['routed'][number]['input']) => {
        s.routed.push({ id, input });
        if (s.routeThrows) {
          throw new Error(`router blew up on: ${SECRET_INTENT}`);
        }
        return s.routeResult;
      },
      startRunnableWorkflow: async () => undefined,
      startRunPlanGeneration: async (
        id: string,
        input: Record<string, unknown>,
        memo: Record<string, unknown>
      ) => {
        if (s.startThrows) {
          throw new Error('temporal down');
        }
        if (s.startResult.started) {
          s.started.push({ id, input, memo });
          s.jobs.set(id, { memo, status: 'running' });
        }
        return s.startResult;
      },
    } as unknown as never);
    routeConfigs = [];
    app.addHook('onRoute', (route) => {
      routeConfigs.push({ ...(route.config ?? {}) });
    });
    app.log.warn = ((obj: unknown, msg?: string) => {
      logs.push(JSON.stringify([obj, msg]));
    }) as never;
    app.register(runPlanRoutes, { prefix: '/api/v1/run-plans' });
    await app.ready();
  });

  afterEach(() => app.close());

  const H = { authorization: 'Bearer t' };
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ headers: { ...H, ...headers }, method: 'POST', payload: payload as never, url });
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ headers: { ...H, ...headers }, method: 'GET', url });
  const create = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    post('/api/v1/run-plans', { intent: SECRET_INTENT, repoId: REPO, ...extra }, headers);

  const generated = (over: Record<string, unknown> = {}) => ({
    closedAt: new Date(),
    input: {
      agentKey: null,
      intent: SECRET_INTENT,
      launchableAgentKeys: ['contentWriter'],
      mode: 'delivering',
      orgId: 'org-1',
      teamId: 'team-1',
    },
    memo: {
      intentHash: 'x',
      mode: 'delivering',
      ownerUserId: USER,
      repoId: REPO,
      teamId: 'team-1',
    },
    result: {
      agentPins: { implementer: 'GLOBAL:3' },
      catalogHash: 'c',
      costEstimate: { totalUsd: 1.5, unpriced: [] },
      injected: ['gatherTicket'],
      model: 'anthropic/x',
      spec: {
        entry: 'gather',
        nodes: {
          gather: { step: 'gatherTicketContext', type: 'step' },
          implement: { step: 'executeImplementation', type: 'step' },
        },
      },
    },
    status: 'done',
    ...over,
  });

  describe('authorization', () => {
    it('refuses a request with no token', async () => {
      const res = await app.inject({
        method: 'POST',
        payload: { intent: 'x', repoId: REPO },
        url: '/api/v1/run-plans',
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a service principal on every route, and no route opts in to service tokens', async () => {
      const calls = [
        ['POST', '/api/v1/run-plans/route', { intent: 'x', repoId: REPO }],
        ['POST', '/api/v1/run-plans', { intent: 'x', repoId: REPO }],
        ['GET', '/api/v1/run-plans/jobs/runplan-0a1b2c3d-0123456789abcdef', undefined],
        ['GET', '/api/v1/run-plans', undefined],
        ['GET', `/api/v1/run-plans/${PLAN}`, undefined],
        ['POST', `/api/v1/run-plans/${PLAN}/approve`, undefined],
        ['POST', `/api/v1/run-plans/${PLAN}/reject`, undefined],
      ] as const;
      for (const [method, url, payload] of calls) {
        const res = await app.inject({
          headers: { ...H, 'x-test-principal': '1' },
          method,
          ...(payload ? { payload } : {}),
          url,
        });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code).toBe('RUN_PLAN_SERVICE_FORBIDDEN');
      }
      expect(s.started).toEqual([]);
      expect(m.approve).not.toHaveBeenCalled();
      expect(routeConfigs.some((c) => c.serviceScopes !== undefined)).toBe(false);
    });

    it('answers a repository the caller cannot reach like one that does not exist, and spends nothing', async () => {
      s.reach = false;
      const res = await create();
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('CONNECTION_NOT_FOUND');
      expect(s.started).toEqual([]);
      expect(s.audit).toEqual([]);
      const route = await post('/api/v1/run-plans/route', { intent: 'x', repoId: REPO });
      expect(route.statusCode).toBe(404);
      expect(s.routed).toEqual([]);
    });

    it('checks reach with the launch decision (the caller is the actor, shared teams included)', async () => {
      await create();
      const input = m.validate.mock.calls[0]?.[0] as {
        connectionId: string;
        templateTeamId: unknown;
        user: { sub: string };
      };
      expect(input.connectionId).toBe(REPO);
      expect(input.user.sub).toBe(USER);
      expect(input.templateTeamId).toBeNull();
    });

    it('refuses a repository host that is not on the approved list', async () => {
      hostState.ok = false;
      const res = await create();
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('REPO_HOST_NOT_ALLOWED');
      expect(s.started).toEqual([]);
    });
  });

  describe('POST /run-plans', () => {
    it('starts a delivering generation with server-computed inputs and answers 202 {jobId}', async () => {
      const res = await create();
      expect(res.statusCode).toBe(202);
      const { jobId } = res.json().data;
      expect(jobId).toMatch(/^runplan-0a1b2c3d-[0-9a-f]{32}$/);
      expect(s.started).toHaveLength(1);
      const start = s.started[0] as State['started'][number];
      expect(start.id).toBe(jobId);
      expect(start.input).toEqual({
        intent: SECRET_INTENT,
        launchableAgentKeys: ['contentWriter', 'docsMaintainer'],
        mode: 'delivering',
        orgId: 'org-1',
        teamId: 'team-1',
      });
      expect(start.memo).toMatchObject({
        mode: 'delivering',
        ownerUserId: USER,
        repoId: REPO,
        teamId: 'team-1',
      });
      expect(start.memo.intentHash).toMatch(/^[0-9a-f]{64}$/);
      // The memo never carries the intent text.
      expect(JSON.stringify(start.memo)).not.toContain('zebra');
      // The start is on the record, by ids and mode.
      expect(s.audit).toHaveLength(1);
      expect((s.audit[0] as { data: Record<string, unknown> }).data).toMatchObject({
        action: 'CREATE',
        actorId: USER,
        entityId: planIdForJob(USER, jobId),
        entityType: 'RunPlan',
      });
      expect(JSON.stringify(s.audit)).not.toContain('zebra');
    });

    it('computes the launchable agents with the agent-run rules: GLOBAL and ORGANIZATION, no platform agents', async () => {
      await create();
      const where = whereOf(s.queries.agents[0]) as {
        isActive: boolean;
        key: { notIn: string[] };
        OR: unknown[];
      };
      expect(where.isActive).toBe(true);
      expect(where.key.notIn).toEqual(expect.arrayContaining(['securityReview', 'evalJudge']));
      expect(where.OR).toEqual([
        { channelId: null, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
        { orgId: 'org-1', scope: 'ORGANIZATION' },
      ]);
    });

    it('builds an output-only plan on a launchable agent', async () => {
      const res = await create({ agent: 'docsMaintainer' });
      expect(res.statusCode).toBe(202);
      expect(s.started[0]?.input).toMatchObject({
        agentKey: 'docsMaintainer',
        mode: 'output-only',
      });
      expect(s.started[0]?.memo.mode).toBe('output-only');
    });

    it('refuses a platform agent (400) and an agent outside the launchable set (404)', async () => {
      const platform = await create({ agent: 'securityReview' });
      expect(platform.statusCode).toBe(400);
      expect(platform.json().error.code).toBe('AGENT_NOT_LAUNCHABLE');
      const unknown = await create({ agent: 'someoneElsesTeamAgent' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('AGENT_NOT_FOUND');
      expect(s.started).toEqual([]);
    });

    it('rejects a body that tries to supply the mode or the launchable agent keys', async () => {
      for (const extra of [
        { launchableAgentKeys: ['securityReview'] },
        { mode: 'delivering' },
        { teamId: 'team-9' },
      ]) {
        const res = await create(extra);
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      expect(s.started).toEqual([]);
    });

    it('bounds the intent: empty and over 8000 characters are refused, 8000 is not', async () => {
      expect((await create({ intent: '   ' })).statusCode).toBe(400);
      expect((await create({ intent: 'x'.repeat(8001) })).statusCode).toBe(400);
      expect((await create({ intent: 'x'.repeat(8000) })).statusCode).toBe(202);
    });

    it('honours the kill switch', async () => {
      cfg.settings['runPlans.enabled'] = false;
      const res = await create();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('RUN_PLANS_DISABLED');
      expect(s.started).toEqual([]);
      expect(s.audit).toEqual([]);
    });

    it('limits generations per hour, counting every start, and 0 disables generation', async () => {
      cfg.settings['runPlans.createPerUserPerHour'] = 2;
      expect((await create()).statusCode).toBe(202);
      expect((await create()).statusCode).toBe(202);
      const third = await create();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RUN_PLAN_RATE_LIMITED');
      expect(s.started).toHaveLength(2);
      cfg.settings['runPlans.createPerUserPerHour'] = 0;
      const off = await create();
      expect(off.statusCode).toBe(403);
      expect(off.json().error.code).toBe('RUN_PLANS_DISABLED');
    });

    it('caps the plans a person may hold waiting for approval', async () => {
      cfg.settings['runPlans.maxPendingPerUser'] = 1;
      s.plans.push({
        expiresAt: new Date(Date.now() + 60_000),
        id: PLAN,
        ownerUserId: USER,
        status: 'PENDING',
      });
      const res = await create();
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RUN_PLAN_PENDING_LIMIT');
      expect(s.started).toEqual([]);
    });

    it('resolves the settings at the repository team and organization', async () => {
      const config = await import('@auto-swe/shared/config');
      await create();
      expect(config.resolveSettings).toHaveBeenCalledWith(
        expect.arrayContaining(['runPlans.enabled', 'runPlans.createPerUserPerHour']),
        { orgId: 'org-1', teamId: 'team-1' }
      );
    });

    it('returns the same job for a retried Idempotency-Key, without starting or charging twice', async () => {
      const first = await create({}, { 'idempotency-key': 'key-0001' });
      const second = await create({}, { 'idempotency-key': 'key-0001' });
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.json().data.jobId).toBe(first.json().data.jobId);
      expect(second.json().data.deduplicated).toBe(true);
      expect(first.json().data.jobId).toMatch(/^runplan-0a1b2c3d-[0-9a-f]{16}$/);
      expect(s.started).toHaveLength(1);
      expect(s.audit).toHaveLength(1);
    });

    it('refuses an Idempotency-Key reused for a different goal', async () => {
      await create({}, { 'idempotency-key': 'key-0002' });
      const res = await create(
        { intent: 'something else entirely' },
        { 'idempotency-key': 'key-0002' }
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    });

    it('does not describe another person’s job to a caller whose key collides with it', async () => {
      const first = await create({}, { 'idempotency-key': 'key-0003' });
      const jobId = first.json().data.jobId;
      s.jobs.set(jobId, {
        memo: { ...(s.started[0]?.memo as object), ownerUserId: OTHER },
        status: 'running',
      });
      const res = await create({}, { 'idempotency-key': 'key-0003' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    });

    it('gives back the quota of a start that raced its own retry', async () => {
      s.startResult = { started: false };
      const res = await create({}, { 'idempotency-key': 'key-0004' });
      // The job is not there for the replay either, so the caller is told to use a new key.
      expect(res.statusCode).toBe(409);
      expect(s.audit).toEqual([]);
    });

    it('takes back the generation count when Temporal refuses the start', async () => {
      s.startThrows = true;
      const res = await create();
      expect(res.statusCode).toBe(500);
      expect(s.audit).toEqual([]);
    });
  });

  describe('GET /run-plans/jobs/:jobId', () => {
    const JOB = 'runplan-0a1b2c3d-0123456789abcdef0123456789abcdef';

    it('answers 404 for an unknown job, a malformed id, and another person’s job alike', async () => {
      expect((await get(`/api/v1/run-plans/jobs/${JOB}`)).statusCode).toBe(404);
      expect((await get('/api/v1/run-plans/jobs/wfauthorjob-abc')).statusCode).toBe(400);
      s.jobs.set(JOB, generated({ memo: { ...generated().memo, ownerUserId: OTHER } }));
      const res = await get(`/api/v1/run-plans/jobs/${JOB}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('RUN_PLAN_JOB_NOT_FOUND');
      // A job with no memo says nothing about its owner and is refused too.
      s.jobs.set(JOB, { memo: {}, status: 'running' });
      expect((await get(`/api/v1/run-plans/jobs/${JOB}`)).statusCode).toBe(404);
      expect(m.create).not.toHaveBeenCalled();
    });

    it('reports a running job', async () => {
      s.jobs.set(JOB, { memo: generated().memo, status: 'running' });
      const res = await get(`/api/v1/run-plans/jobs/${JOB}`);
      expect(res.json()).toEqual({ data: { status: 'running' } });
    });

    it.each([
      ['GENERATION_FAILED', 'PLAN_GENERATION_FAILED', true],
      ['PLAN_INPUT_INVALID', 'PLAN_INPUT_INVALID', false],
      ['PLANNED_RUN_TEMPLATE_MISSING', 'PLANNED_RUN_TEMPLATE_MISSING', false],
      ['AGENTS_UNAVAILABLE', 'PLAN_AGENTS_UNAVAILABLE', false],
      ['GENERATION_UNAVAILABLE', 'PLAN_GENERATION_UNAVAILABLE', true],
    ])('maps the worker failure %s to the stable code %s', async (workerCode, code, retryable) => {
      s.jobs.set(JOB, { code: workerCode, memo: generated().memo, status: 'failed' });
      const body = (await get(`/api/v1/run-plans/jobs/${JOB}`)).json().data;
      expect(body).toMatchObject({ code, retryable, status: 'failed' });
      expect(typeof body.message).toBe('string');
      expect(JSON.stringify(body)).not.toContain('zebra');
    });

    it('persists a finished job as a plan, once, however often it is polled', async () => {
      s.jobs.set(JOB, generated());
      const a = await get(`/api/v1/run-plans/jobs/${JOB}`);
      const b = await get(`/api/v1/run-plans/jobs/${JOB}`);
      const c = await get(`/api/v1/run-plans/jobs/${JOB}`);
      const planId = planIdForJob(USER, JOB);
      for (const res of [a, b, c]) {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ data: { planId, status: 'done' } });
      }
      expect(m.create).toHaveBeenCalledTimes(1);
      expect(s.plans.filter((p) => p.id === planId)).toHaveLength(1);
      const input = m.create.mock.calls[0]?.[1] as CreateInput;
      expect(input).toMatchObject({
        connectionId: REPO,
        id: planId,
        intent: SECRET_INTENT,
        mode: 'delivering',
        owner: { sub: USER },
        routerCandidates: { injected: ['gatherTicket'] },
        settingsSnapshot: { 'workflow.maxTransitions': 500 },
      });
      // One audit row for the creation.
      expect(s.audit.filter((a) => eventOf(a) === 'run_plan.created')).toHaveLength(1);
    });

    it('never returns the spec, the intent or the pins from the jobs endpoint', async () => {
      s.jobs.set(JOB, generated());
      const text = (await get(`/api/v1/run-plans/jobs/${JOB}`)).body;
      for (const leak of [
        'zebra',
        'executeImplementation',
        'gatherTicketContext',
        'pins',
        'nodes',
      ]) {
        expect(text).not.toContain(leak);
      }
    });

    it('reads the existing row when two polls race to create it', async () => {
      s.jobs.set(JOB, generated());
      s.raceOnCreate = true;
      const res = await get(`/api/v1/run-plans/jobs/${JOB}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ planId: planIdForJob(USER, JOB), status: 'done' });
    });

    it('reports a creation refusal (quota, policy) as a failed job and creates nothing', async () => {
      s.jobs.set(JOB, generated());
      m.create.mockResolvedValueOnce({
        code: 'RUN_PLAN_PENDING_LIMIT',
        message: 'You already hold the most plans',
        ok: false,
        status: 429,
      });
      const body = (await get(`/api/v1/run-plans/jobs/${JOB}`)).json().data;
      expect(body).toMatchObject({
        code: 'RUN_PLAN_PENDING_LIMIT',
        retryable: true,
        status: 'failed',
      });
      expect(s.plans).toEqual([]);
    });

    it('does not turn a job that finished long ago into a plan', async () => {
      s.jobs.set(JOB, generated({ closedAt: new Date(Date.now() - 25 * 3_600_000) }));
      const body = (await get(`/api/v1/run-plans/jobs/${JOB}`)).json().data;
      expect(body).toMatchObject({ code: 'PLAN_JOB_EXPIRED', status: 'failed' });
      expect(m.create).not.toHaveBeenCalled();
    });

    it('never logs the intent', async () => {
      s.jobs.set(JOB, generated());
      await get(`/api/v1/run-plans/jobs/${JOB}`);
      expect(logs.join('')).not.toContain('zebra');
    });
  });

  describe('GET /run-plans/:id and the list', () => {
    const plan = (over: Record<string, unknown> = {}): Row =>
      ({
        agentKey: null,
        agentPins: { implementer: 'GLOBAL:3' },
        approvedAt: null,
        connectionId: REPO,
        costEstimate: { totalUsd: 2, unpriced: ['n1'] },
        createdAt: new Date('2026-11-17T12:00:00Z'),
        expiresAt: new Date('2026-11-17T12:30:00Z'),
        id: PLAN,
        intent: SECRET_INTENT,
        launchedWorkflowRunId: null,
        mode: 'delivering',
        model: 'anthropic/x',
        ownerUserId: USER,
        routerCandidates: { injected: ['gatherTicket'] },
        skeletonReport: {
          mandatory: { implementation: ['implement'] },
          regions: { core: ['implement'], post: [], pre: ['gather', 'gatherTicket'] },
          warnings: [{ code: 'W1', message: 'careful', nodeId: 'gather' }],
        },
        spec: {
          entry: 'gather',
          nodes: {
            gather: { step: 'x', type: 'step' },
            gatherTicket: { step: 'gatherTicketContext', type: 'step' },
            implement: { step: 'executeImplementation', type: 'step' },
          },
        },
        specHash: 'h',
        status: 'PENDING',
        teamId: 'team-1',
        validationReport: { errors: [], warnings: [{ code: 'V1', message: 'hm' }] },
        ...over,
      }) as Row;

    it('shows the owner the whole plan, marking core, injected and free nodes', async () => {
      s.plans.push(plan());
      const res = await get(`/api/v1/run-plans/${PLAN}`);
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d).toMatchObject({
        agentPins: { implementer: 'GLOBAL:3' },
        cost: { totalUsd: 2, unpriced: ['n1'] },
        expiresAt: '2026-11-17T12:30:00.000Z',
        intent: SECRET_INTENT,
        mode: 'delivering',
        status: 'PENDING',
      });
      expect(d.spec.nodes.implement).toBeDefined();
      const marker = Object.fromEntries(
        d.nodes.map((n: { id: string; marker: string }) => [n.id, n.marker])
      );
      expect(marker).toEqual({ gather: 'free', gatherTicket: 'injected', implement: 'core' });
      expect(
        d.warnings.map((w: { code: string; source: string }) => `${w.source}:${w.code}`)
      ).toEqual(['skeleton:W1', 'validation:V1']);
    });

    it('answers 404 to anyone else, and for a plan that does not exist', async () => {
      s.plans.push(plan({ ownerUserId: OTHER }));
      expect((await get(`/api/v1/run-plans/${PLAN}`)).statusCode).toBe(404);
      expect((await get('/api/v1/run-plans/0b1c2d3e-0000-4000-8000-0000000000ff')).statusCode).toBe(
        404
      );
      expect((await get('/api/v1/run-plans/not-a-uuid')).statusCode).toBe(400);
    });

    it('lists only the caller’s plans, newest first, with paging, a status filter and no spec', async () => {
      for (let i = 0; i < 5; i++) {
        s.plans.push(
          plan({
            id: `0b1c2d3e-0000-4000-8000-00000000010${i}`,
            status: i % 2 ? 'REJECTED' : 'PENDING',
          })
        );
      }
      s.plans.push(plan({ id: '0b1c2d3e-0000-4000-8000-0000000002ff', ownerUserId: OTHER }));
      const all = (await get('/api/v1/run-plans?limit=2&offset=0')).json();
      expect(all.data).toHaveLength(2);
      expect(all.meta).toEqual({ limit: 2, offset: 0, total: 5 });
      const rejected = (await get('/api/v1/run-plans?status=REJECTED')).json();
      expect(rejected.data.every((p: { status: string }) => p.status === 'REJECTED')).toBe(true);
      expect(rejected.meta.total).toBe(2);
      const text = JSON.stringify(all);
      expect(text).not.toContain('"spec"');
      expect(text).not.toContain('0b1c2d3e-0000-4000-8000-0000000002ff');
      expect((await get('/api/v1/run-plans?status=NOPE')).statusCode).toBe(400);
      expect((await get('/api/v1/run-plans?limit=1000')).statusCode).toBe(400);
    });

    it('truncates a long intent in the list but not in the plan', async () => {
      s.plans.push(plan({ intent: 'y'.repeat(500) }));
      const listed = (await get('/api/v1/run-plans')).json().data[0];
      expect(listed.intent.length).toBeLessThan(250);
      expect((await get(`/api/v1/run-plans/${PLAN}`)).json().data.intent).toHaveLength(500);
    });
  });

  describe('POST /run-plans/:id/approve', () => {
    const approveUrl = `/api/v1/run-plans/${PLAN}/approve`;
    const refusal = (status: number, code: string) => ({
      code,
      message: `m ${code}`,
      ok: false,
      status,
    });

    it('launches an approved plan and answers like an agent run', async () => {
      m.approve.mockResolvedValueOnce({
        activeWorkflowId: 'aw-1',
        ok: true,
        planId: PLAN,
        temporalWorkflowId: 'plan-abc',
        workRequestId: 'wr-1',
      });
      const res = await post(approveUrl, undefined);
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toEqual({
        planId: PLAN,
        temporalWorkflowId: 'plan-abc',
        workflowId: 'aw-1',
        workRequestId: 'wr-1',
      });
      expect(m.approve.mock.calls[0]?.[1]).toEqual({ sub: USER });
      expect(s.audit.some((a) => eventOf(a) === 'run_plan.approved')).toBe(true);
    });

    it.each([
      [refusal(404, 'PLAN_NOT_FOUND'), 404, undefined],
      [refusal(409, 'PLAN_NOT_PENDING'), 409, undefined],
      [refusal(409, 'PLAN_EXPIRED'), 409, undefined],
      [refusal(409, 'PLAN_AGENTS_CHANGED'), 409, { drift: 'agents' }],
      [refusal(409, 'PLAN_SETTINGS_CHANGED'), 409, { drift: 'settings' }],
      [refusal(409, 'PLAN_CATALOG_CHANGED'), 409, { drift: 'catalog' }],
      [refusal(409, 'PLAN_REPOSITORY_CHANGED'), 409, { drift: 'repository' }],
      [refusal(409, 'PLAN_TAMPERED'), 409, { drift: 'spec' }],
      [refusal(403, 'FORBIDDEN'), 403, undefined],
      [refusal(404, 'CONNECTION_NOT_FOUND'), 404, undefined],
      [refusal(429, 'AGENT_RUN_CONCURRENCY_EXCEEDED'), 429, undefined],
      [refusal(409, 'PLAN_POLICY_FAILED'), 422, undefined],
      [refusal(409, 'PLAN_SPEC_INVALID'), 422, undefined],
      [refusal(409, 'PLAN_AGENT_MISMATCH'), 422, undefined],
      [refusal(403, 'RUN_PLANS_DISABLED'), 403, undefined],
      [refusal(503, 'PLANNED_RUN_TEMPLATE_MISSING'), 503, undefined],
    ])('maps %j to HTTP %i', async (r, status, details) => {
      m.approve.mockResolvedValueOnce(r);
      const res = await post(approveUrl, undefined);
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(r.code);
      expect(res.json().error.details).toEqual(details);
    });

    it('returns the earlier launch for a retried approval that carries an Idempotency-Key', async () => {
      s.launched = true;
      m.approve.mockResolvedValue(refusal(409, 'PLAN_NOT_PENDING'));
      const keyed = await post(approveUrl, undefined, { 'idempotency-key': 'approve-1' });
      expect(keyed.statusCode).toBe(200);
      expect(keyed.json().data).toEqual({
        deduplicated: true,
        planId: PLAN,
        workRequestId: 'wr-1',
      });
      const plain = await post(approveUrl, undefined);
      expect(plain.statusCode).toBe(409);
    });

    it('passes the owner only, and a caller-supplied owner field is a validation error', async () => {
      const res = await post(approveUrl, { ownerUserId: OTHER });
      expect(res.statusCode).toBe(400);
      expect(m.approve).not.toHaveBeenCalled();
    });
  });

  describe('POST /run-plans/:id/reject', () => {
    const rejectUrl = `/api/v1/run-plans/${PLAN}/reject`;

    it('rejects the owner’s pending plan', async () => {
      s.plans.push({ id: PLAN, ownerUserId: USER, status: 'PENDING', teamId: 'team-1' });
      const res = await post(rejectUrl, undefined);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ planId: PLAN, status: 'REJECTED' });
      expect(s.plans[0]?.status).toBe('REJECTED');
      expect(s.audit.some((a) => eventOf(a) === 'run_plan.rejected')).toBe(true);
    });

    it('answers 404 for someone else’s plan, 409 for one that can no longer be rejected', async () => {
      s.plans.push({ id: PLAN, ownerUserId: OTHER, status: 'PENDING', teamId: 'team-1' });
      expect((await post(rejectUrl, undefined)).statusCode).toBe(404);
      s.plans[0] = { id: PLAN, ownerUserId: USER, status: 'LAUNCHED', teamId: 'team-1' };
      const res = await post(rejectUrl, undefined);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PLAN_NOT_REJECTABLE');
    });
  });

  describe('POST /run-plans/route', () => {
    const route = (extra: Record<string, unknown> = {}) =>
      post('/api/v1/run-plans/route', { intent: SECRET_INTENT, repoId: REPO, ...extra });

    it('offers the router only templates the caller may launch, and none of the system ones', async () => {
      s.routeResult = {
        matches: [{ reason: 'fits', score: 0.9, templateId: 't-1' }],
        noneFit: false,
      };
      const res = await route();
      expect(res.statusCode).toBe(200);
      const where = whereOf(s.queries.templates[0]);
      // Active with a version, the visibility filter, system templates out, repository-fit only.
      const text = JSON.stringify(where);
      expect(text).toContain('"status":"ACTIVE"');
      expect(text).toContain('"startsWith":"system:"');
      expect(text).toContain('git_repo');
      expect(text).toContain('team-1');
      expect(text).toContain(USER);
      expect((s.queries.templates[0] as { orderBy: unknown[] }).orderBy[0]).toEqual({
        updatedAt: 'desc',
      });
      const offered = s.routed[0]?.input.candidates.map((c) => c.id);
      // Review kind, the Channel Assistant and the Planned Run template never reach the router.
      expect(offered).toEqual(['t-1', 't-2']);
      expect(s.routed[0]?.input.maxResults).toBeGreaterThan(0);
    });

    it('caps the candidates at 100', async () => {
      s.templates = Array.from({ length: 250 }, (_, i) => ({
        description: 'd',
        id: `t-${i}`,
        kind: null,
        name: `n${i}`,
        teamId: null,
      }));
      await route();
      expect(s.routed[0]?.input.candidates).toHaveLength(100);
    });

    it('drops any id the router returns that was not offered, and joins name and description', async () => {
      s.routeResult = {
        matches: [
          { reason: 'injected', score: 1, templateId: 'someone-elses-template' },
          { reason: 'fits', score: 0.8, templateId: 't-2' },
        ],
        noneFit: false,
      };
      const body = (await route()).json().data;
      expect(body.matches).toEqual([
        { description: 'Docs sweep', name: 'Docs', reason: 'fits', score: 0.8, templateId: 't-2' },
      ]);
      expect(body.noneFit).toBe(false);
      s.routeResult = {
        matches: [{ reason: 'x', score: 1, templateId: 'not-offered' }],
        noneFit: false,
      };
      expect((await route()).json().data).toEqual({ matches: [], noneFit: true });
    });

    it('says nothing fits without calling the router when the caller has no candidate', async () => {
      s.templates = [];
      expect((await route()).json().data).toEqual({ matches: [], noneFit: true });
      expect(s.routed).toEqual([]);
    });

    it('applies the kill switch and the hourly ranking limit, and 0 disables it', async () => {
      cfg.settings['runPlans.routePerUserPerHour'] = 1;
      expect((await route()).statusCode).toBe(200);
      const limited = await route();
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('RUN_PLAN_RATE_LIMITED');
      cfg.settings['runPlans.routePerUserPerHour'] = 0;
      expect((await route()).statusCode).toBe(403);
      cfg.settings['runPlans.enabled'] = false;
      cfg.settings['runPlans.routePerUserPerHour'] = 30;
      const off = await route();
      expect(off.statusCode).toBe(403);
      expect(off.json().error.code).toBe('RUN_PLANS_DISABLED');
    });

    it('leaves the caller with "generate new" when the router fails, and logs no intent', async () => {
      s.routeThrows = true;
      const res = await route();
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('RUN_PLAN_ROUTER_UNAVAILABLE');
      expect(res.body).not.toContain('zebra');
      expect(logs.join('')).not.toContain('zebra');
    });

    it('rejects a body that names candidates or a mode', async () => {
      expect((await route({ candidates: [{ id: 't-9' }] })).statusCode).toBe(400);
      expect((await route({ mode: 'delivering' })).statusCode).toBe(400);
      expect((await route({ intent: 'x'.repeat(8001) })).statusCode).toBe(400);
    });
  });
});
