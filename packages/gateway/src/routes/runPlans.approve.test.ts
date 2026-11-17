import { hashRunPlanSpec, runPlanCatalogHash } from '@auto-swe/shared/workflow/runPlan';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The approve route with the REAL plan service behind it (the other suite replaces
 * `approveAndLaunchPlan`): the retry rules depend on what the service leaves in the tables, so they
 * are exercised against a stand-in database that keeps the plan, the audit rows and the run rows.
 */

const m = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => 'open'),
  resolveSettings: vi.fn(async () => ({
    'runPlans.createPerUserPerHour': 10,
    'runPlans.enabled': true,
    'runPlans.maxPendingPerUser': 5,
    'runPlans.routePerUserPerHour': 30,
  })),
  snapshotPinnedSettings: vi.fn(async () => ({ 'workflow.maxTransitions': 500 })),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: false, hosts: [] })),
}));
vi.mock('@auto-swe/shared/workflow/runPlan', async (original) => ({
  ...(await original<object>()),
  // The policy has its own suites; here only the service's flow matters.
  checkSkeletonPolicy: vi.fn(() => ({ errors: [], ok: true })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('../lib/runConnection.js', () => ({ validateRunConnection: async () => ({ ok: true }) }));
vi.mock('../lib/workflowLaunch.js', () => ({ launchTrackedWorkflow: m.launch }));

import { runPlanRoutes } from './runPlans.js';

const USER = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const REPO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PLAN = '0b1c2d3e-0000-4000-8000-000000000001';
const SPEC = {
  description: '',
  entry: 'a',
  name: 'plan',
  nodes: { a: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

interface Tables {
  plan: Record<string, unknown>;
  audit: Array<{ id: string; data: Record<string, unknown> }>;
  runInputs: Array<{ id: string; externalTicketId: string; requestedById: string }>;
  active: Array<{ workRequestId: string; currentStatus: string }>;
  runs: Array<{ id: string; status: string }>;
}

describe('POST /run-plans/:id/approve with the real service', () => {
  let app: FastifyInstance;
  let t: Tables;
  const url = `/api/v1/run-plans/${PLAN}/approve`;
  const approve = (key?: string) =>
    app.inject({
      headers: { authorization: 'Bearer t', ...(key ? { 'idempotency-key': key } : {}) },
      method: 'POST',
      url,
    });

  beforeEach(async () => {
    m.launch.mockReset();
    // A launch that holds: the ledger rows exist and the workflow started.
    m.launch.mockImplementation(
      async (
        _prisma: unknown,
        rows: { runInput: { id: string; externalTicketId: string; requestedById: string } },
        start: () => Promise<void>
      ) => {
        await start();
        t.runInputs.push({
          externalTicketId: rows.runInput.externalTicketId,
          id: rows.runInput.id,
          requestedById: rows.runInput.requestedById,
        });
        t.active.push({ currentStatus: 'IMPLEMENTING', workRequestId: rows.runInput.id });
        return { activeWorkflowId: 'aw-1', ok: true };
      }
    );
    t = {
      active: [],
      audit: [],
      plan: {
        agentKey: null,
        agentPins: { implementer: 'GLOBAL:3' },
        approvedAt: null,
        approvedById: null,
        catalogHash: runPlanCatalogHash(),
        connectionId: REPO,
        expiresAt: new Date(Date.now() + 25 * 60_000),
        id: PLAN,
        intent: 'add a health endpoint',
        launchedWorkflowRunId: null,
        mode: 'delivering',
        ownerUserId: USER,
        settingsSnapshot: { 'workflow.maxTransitions': 500 },
        spec: SPEC,
        specHash: hashRunPlanSpec(SPEC),
        status: 'PENDING',
        teamId: 'team-1',
      },
      runInputs: [],
      runs: [],
    };

    const prisma = {
      activeWorkflow: {
        findFirst: async ({ where }: { where: { workRequestId: string } }) =>
          t.active.find((a) => a.workRequestId === where.workRequestId) ?? null,
      },
      agent: {
        findFirst: async ({ where }: { where: { key: string; scope: string } }) =>
          where.key === 'implementer' && where.scope === 'GLOBAL'
            ? { scope: 'GLOBAL', version: 3 }
            : null,
        findMany: async () => [{ key: 'docsMaintainer' }],
      },
      configAuditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          const id = `audit-${t.audit.length + 1}`;
          t.audit.push({ data: args.data, id });
          return { id };
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const clauses = (
            where.AND as Array<{ afterJson: { equals: unknown; path: string[] } }>
          ).map((c) => c.afterJson);
          const hit = t.audit.find(
            (a) =>
              a.data.entityId === where.entityId &&
              a.data.actorId === where.actorId &&
              a.data.action === where.action &&
              clauses.every(
                (c) =>
                  (a.data.afterJson as Record<string, unknown>)[c.path[0] as string] === c.equals
              )
          );
          return hit ? { id: hit.id } : null;
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
        findFirst: async ({
          where,
        }: {
          where: { externalTicketId: string; requestedById: string };
        }) =>
          t.runInputs.find(
            (r) =>
              r.externalTicketId === where.externalTicketId &&
              r.requestedById === where.requestedById
          ) ?? null,
      },
      runPlan: {
        findUnique: async () => ({ ...t.plan }),
        updateMany: async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          const ok = Object.entries(where).every(([k, v]) => {
            const actual = t.plan[k];
            if (v && typeof v === 'object' && !(v instanceof Date)) {
              const gt = (v as { gt?: Date }).gt;
              return gt ? (actual as Date).getTime() > gt.getTime() : true;
            }
            return actual === v;
          });
          if (!ok) {
            return { count: 0 };
          }
          Object.assign(t.plan, data);
          return { count: 1 };
        },
      },
      team: { findUnique: async () => ({ orgId: 'org-1' }) },
      user: { findUnique: async () => ({ id: USER, isActive: true, role: 'ENGINEER' }) },
      workflowRun: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          t.runs.find((r) => r.id === where.id) ?? null,
      },
      workflowTemplate: { findFirst: async () => ({ activeVersion: 1, id: 'tpl-planned' }) },
    };

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: USER }),
    } as unknown as never);
    app.decorate('prisma', prisma as unknown as never);
    app.decorate('temporal', {
      isWorkflowGone: async () => true,
      startRunnableWorkflow: async () => undefined,
    } as unknown as never);
    app.register(runPlanRoutes, { prefix: '/api/v1/run-plans' });
    await app.ready();
  });

  afterEach(() => app.close());

  /** What the worker does once it has pinned the plan and created the run. */
  const workerClaims = () => {
    t.runs.push({ id: 'run-1', status: 'RUNNING' });
    Object.assign(t.plan, { launchedWorkflowRunId: 'run-1', status: 'LAUNCHED' });
  };

  it('answers a retry with the same key with the earlier launch, and any other request as not pending', async () => {
    const first = await approve('approve-key-1');
    expect(first.statusCode).toBe(201);
    const workRequestId = first.json().data.workRequestId;
    workerClaims();

    const retry = await approve('approve-key-1');
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data).toEqual({ deduplicated: true, planId: PLAN, workRequestId });
    expect(m.launch).toHaveBeenCalledTimes(1);

    // Another key, or none, did not make that approval: the plan is simply not pending.
    for (const other of [approve('approve-key-2'), approve()]) {
      const res = await other;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PLAN_NOT_PENDING');
    }
  });

  it('also answers a retry made before the worker has claimed the plan', async () => {
    const first = await approve('approve-key-1');
    expect(t.plan.status).toBe('APPROVED');
    const retry = await approve('approve-key-1');
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.workRequestId).toBe(first.json().data.workRequestId);
  });

  it('reports a failed run as PLAN_LAUNCH_FAILED instead of deduplicating it as a success', async () => {
    const first = await approve('approve-key-1');
    expect(first.statusCode).toBe(201);
    // The worker refused the plan: the ledger row is FAILED and the plan never launched.
    (t.active[0] as { currentStatus: string }).currentStatus = 'FAILED';
    const retry = await approve('approve-key-1');
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('PLAN_LAUNCH_FAILED');
    expect(retry.json().error.details).toMatchObject({
      planStatus: 'APPROVED',
      workflowStatus: 'FAILED',
    });
    expect(retry.json().data).toBeUndefined();
  });

  it('reports a run that was launched and then failed', async () => {
    await approve('approve-key-1');
    workerClaims();
    (t.runs[0] as { status: string }).status = 'FAILED';
    const retry = await approve('approve-key-1');
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('PLAN_LAUNCH_FAILED');
    expect(retry.json().error.details).toMatchObject({
      planStatus: 'LAUNCHED',
      runStatus: 'FAILED',
    });
  });

  it('leaves a refused plan refusing, never deduplicated, when the earlier request had no key', async () => {
    await approve();
    workerClaims();
    const retry = await approve('approve-key-late');
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe('PLAN_NOT_PENDING');
  });
});
