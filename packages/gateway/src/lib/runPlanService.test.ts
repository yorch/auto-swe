import { hashRunPlanSpec, runPlanCatalogHash } from '@auto-swe/shared/workflow/runPlan';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hostsOk: { value: true },
  launch: vi.fn(),
  policy: { errors: [] as Array<{ code: string }>, ok: true },
  settings: { value: {} as Record<string, unknown> },
  slots: { value: [] as unknown[] },
  validate: vi.fn(),
}));

vi.mock('@auto-swe/shared/config', async (original) => ({
  ...(await original<object>()),
  resolveSettings: vi.fn(async () => ({
    'workspace.agentRunMaxConcurrentGlobal': 10,
    'workspace.agentRunMaxConcurrentPerTeam': 2,
  })),
  snapshotPinnedSettings: vi.fn(async () => m.settings.value),
}));
vi.mock('@auto-swe/shared/workflow/runPlan', async (original) => ({
  ...(await original<object>()),
  // The policy has its own suites; here only that every step of the service consults it.
  checkSkeletonPolicy: vi.fn(() => ({ errors: m.policy.errors, ok: m.policy.ok })),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(async () =>
    m.hostsOk.value ? { ok: true } : { ok: false, url: 'https://evil.example' }
  ),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('@auto-swe/shared/lib/agentRunAdmission', async (original) => ({
  ...(await original<object>()),
  closeAgentRunLedgerRows: () => async () => undefined,
  loadAgentRunSlots: vi.fn(async () => m.slots.value),
  reconcileAgentRunSlots: vi.fn(async (slots: unknown) => slots),
}));
vi.mock('./runConnection.js', () => ({ validateRunConnection: m.validate }));
vi.mock('./workflowLaunch.js', () => ({ launchTrackedWorkflow: m.launch }));

import { checkSkeletonPolicy } from '@auto-swe/shared/workflow/runPlan';
import {
  approveAndLaunchPlan,
  approvePlan,
  createPlanRecord,
  expirePlans,
  launchApprovedPlan,
  type RunPlanLaunchDeps,
  type RunPlanQuotaPolicy,
  rejectPlan,
} from './runPlanService.js';

const PLAN_ID = '0b1c2d3e-0000-4000-8000-000000000001';
const OWNER = { sub: 'user-1' };
const NOW = new Date('2026-11-17T12:00:00Z');
const SPEC = {
  description: '',
  entry: 'a',
  name: 'plan',
  nodes: { a: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};
const SETTINGS = { 'workflow.maxTransitions': 500 };

interface PlanRow extends Record<string, unknown> {
  id: string;
  status: string;
}

function planRow(over: Record<string, unknown> = {}): PlanRow {
  return {
    agentKey: null,
    agentPins: { implementer: 'GLOBAL:3' },
    approvedAt: null,
    approvedById: null,
    catalogHash: runPlanCatalogHash(),
    connectionId: 'repo-1',
    expiresAt: new Date(NOW.getTime() + 60_000),
    id: PLAN_ID,
    intent: 'add a health endpoint',
    launchedWorkflowRunId: null,
    mode: 'delivering',
    ownerUserId: OWNER.sub,
    settingsSnapshot: SETTINGS,
    spec: SPEC,
    specHash: hashRunPlanSpec(SPEC),
    status: 'PENDING',
    teamId: 'team-1',
    ...over,
  } as PlanRow;
}

/** An in-memory `runPlan` table whose `updateMany` honours the `where` it is given. */
function fakePrisma(
  initial: PlanRow | null,
  opts: { user?: unknown; repo?: Record<string, unknown>; agents?: Record<string, unknown> } = {}
) {
  const table: { plan: PlanRow | null } = { plan: initial ? { ...initial } : null };
  const updates: Array<{ data: Record<string, unknown>; where: Record<string, unknown> }> = [];
  const matches = (row: PlanRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const actual = row[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const cond = v as { in?: unknown[]; gt?: Date; lte?: Date };
        if (cond.in) {
          return cond.in.includes(actual);
        }
        if (cond.gt) {
          return (actual as Date).getTime() > cond.gt.getTime();
        }
        if (cond.lte) {
          return (actual as Date).getTime() <= cond.lte.getTime();
        }
      }
      return actual === v;
    });
  const prisma = {
    agent: {
      findFirst: vi.fn(async ({ where }: { where: { key: string; scope: string } }) => {
        const table2 = opts.agents ?? { implementer: 'GLOBAL:3' };
        const pin = table2[where.key] as string | undefined;
        if (!pin) {
          return null;
        }
        const [scope, version] = pin.split(':');
        return where.scope === scope ? { scope, version: Number(version) } : null;
      }),
    },
    connection: {
      findUnique: vi.fn(async () =>
        opts.repo === undefined
          ? {
              githubApiUrl: null,
              githubUrl: null,
              id: 'repo-1',
              organizationName: 'acme',
              repoName: 'api',
              team: { orgId: 'org-1' },
              teamId: 'team-1',
              type: 'git_repo',
            }
          : opts.repo
      ),
    },
    runPlan: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        table.plan = { id: PLAN_ID, ...data } as PlanRow;
        return { expiresAt: data.expiresAt, id: PLAN_ID };
      }),
      deleteMany: vi.fn(async () => ({ count: 2 })),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        table.plan && matches(table.plan, where) ? { id: table.plan.id } : null
      ),
      findUnique: vi.fn(async () => (table.plan ? { ...table.plan } : null)),
      updateMany: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          updates.push({ data, where });
          if (table.plan && matches(table.plan, where)) {
            Object.assign(table.plan, data);
            return { count: 1 };
          }
          return { count: 0 };
        }
      ),
    },
    user: {
      findUnique: vi.fn(async () =>
        opts.user === undefined ? { id: OWNER.sub, isActive: true, role: 'ENGINEER' } : opts.user
      ),
    },
    workflowTemplate: {
      findFirst: vi.fn(async ({ where }: { where: { name: string } }) =>
        where.name === 'Planned Run'
          ? { activeVersion: 1, id: 'tpl-planned' }
          : { id: 'tpl-agent-run' }
      ),
    },
  };
  return { prisma, table, updates };
}

function deps(prisma: unknown, over: Partial<RunPlanLaunchDeps> = {}): RunPlanLaunchDeps {
  return {
    now: () => NOW,
    prisma: prisma as never,
    temporal: {
      isWorkflowGone: vi.fn(async () => false),
      startRunnableWorkflow: vi.fn(async () => undefined),
    },
    ...over,
  } as RunPlanLaunchDeps;
}

const createInput = (over: Record<string, unknown> = {}) => ({
  agentPins: { implementer: 'GLOBAL:3' },
  catalogHash: runPlanCatalogHash(),
  connectionId: 'repo-1',
  costEstimate: { totalUsd: 1 },
  intent: 'add a health endpoint',
  mode: 'delivering' as const,
  model: 'anthropic/claude-sonnet-5-5',
  owner: OWNER,
  routerCandidates: [],
  settingsSnapshot: SETTINGS,
  spec: SPEC,
  ...over,
});

beforeEach(() => {
  m.policy.ok = true;
  m.policy.errors = [];
  m.hostsOk.value = true;
  m.settings.value = SETTINGS;
  m.slots.value = [];
  m.validate.mockReset().mockResolvedValue({ ok: true });
  m.launch.mockReset().mockResolvedValue({ activeWorkflowId: 'aw-1', ok: true });
  vi.mocked(checkSkeletonPolicy).mockClear();
});

describe('createPlanRecord', () => {
  it('stores a PENDING plan with a computed hash, reports and the repository team', async () => {
    const { prisma, table } = fakePrisma(null);
    const result = await createPlanRecord(deps(prisma), createInput());
    expect(result).toMatchObject({ ok: true, planId: PLAN_ID });
    expect(table.plan).toMatchObject({
      connectionId: 'repo-1',
      mode: 'delivering',
      ownerUserId: OWNER.sub,
      specHash: hashRunPlanSpec(SPEC),
      status: 'PENDING',
      teamId: 'team-1',
    });
    expect(table.plan?.skeletonReport).toMatchObject({ ok: true });
    expect(table.plan?.validationReport).toMatchObject({ errors: [] });
    const expiresAt = table.plan?.expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('decides the repository with the launch decision, as the owner', async () => {
    const { prisma } = fakePrisma(null);
    await createPlanRecord(deps(prisma), createInput());
    expect(m.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'repo-1',
        user: expect.objectContaining({ sub: OWNER.sub }),
      }),
      expect.anything()
    );
  });

  it.each([
    ['an inactive user', { id: 'u', isActive: false, role: 'ENGINEER' }],
    ['a user who is gone', null],
  ])('refuses %s', async (_name, user) => {
    const { prisma } = fakePrisma(null, { user });
    const result = await createPlanRecord(deps(prisma), createInput());
    expect(result).toMatchObject({ code: 'FORBIDDEN', ok: false });
    expect(prisma.runPlan.create).not.toHaveBeenCalled();
  });

  it('refuses a repository the owner cannot use, with the launch decision as the reason', async () => {
    m.validate.mockImplementation(
      async (_input: unknown, reply: { status: (c: number) => { send: (b: unknown) => void } }) => {
        reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'not your repository' } });
        return { ok: false };
      }
    );
    const { prisma } = fakePrisma(null);
    expect(await createPlanRecord(deps(prisma), createInput())).toEqual({
      code: 'FORBIDDEN',
      message: 'not your repository',
      ok: false,
      status: 403,
    });
    expect(prisma.runPlan.create).not.toHaveBeenCalled();
  });

  it('refuses a repository host that is not on the approved list', async () => {
    m.hostsOk.value = false;
    const { prisma } = fakePrisma(null);
    expect(await createPlanRecord(deps(prisma), createInput())).toMatchObject({
      code: 'REPO_HOST_NOT_ALLOWED',
    });
  });

  it('never stores a plan that fails the skeleton policy', async () => {
    m.policy.ok = false;
    m.policy.errors = [{ code: 'CORE_MISMATCH' }];
    const { prisma } = fakePrisma(null);
    expect(await createPlanRecord(deps(prisma), createInput())).toMatchObject({
      code: 'PLAN_POLICY_FAILED',
      ok: false,
    });
    expect(prisma.runPlan.create).not.toHaveBeenCalled();
  });

  it('never stores a spec that fails validation or does not parse', async () => {
    const { prisma } = fakePrisma(null);
    expect(
      await createPlanRecord(deps(prisma), createInput({ spec: { ...SPEC, entry: 'missing' } }))
    ).toMatchObject({ code: 'PLAN_SPEC_INVALID' });
    expect(await createPlanRecord(deps(prisma), createInput({ spec: { nope: 1 } }))).toMatchObject({
      code: 'PLAN_SPEC_INVALID',
    });
    expect(prisma.runPlan.create).not.toHaveBeenCalled();
  });

  it('asks the quota hook, and stops on its refusal', async () => {
    const quotas: RunPlanQuotaPolicy = {
      checkApprove: async () => null,
      checkCreate: vi.fn(async () => ({
        code: 'PLAN_QUOTA',
        message: 'too many',
        ok: false as const,
        status: 429,
      })),
    };
    const { prisma } = fakePrisma(null);
    expect(await createPlanRecord(deps(prisma, { quotas }), createInput())).toMatchObject({
      code: 'PLAN_QUOTA',
      status: 429,
    });
    expect(quotas.checkCreate).toHaveBeenCalledWith({ teamId: 'team-1', userId: OWNER.sub });
    expect(prisma.runPlan.create).not.toHaveBeenCalled();
  });
});

describe('approvePlan', () => {
  it('approves the owner’s pending plan: PENDING -> APPROVED, stamped with who and when', async () => {
    const { prisma, table } = fakePrisma(planRow());
    const result = await approvePlan(deps(prisma), OWNER, PLAN_ID);
    expect(result.ok).toBe(true);
    expect(table.plan).toMatchObject({
      approvedAt: NOW,
      approvedById: OWNER.sub,
      status: 'APPROVED',
    });
    expect(prisma.runPlan.updateMany).toHaveBeenCalledWith({
      data: { approvedAt: NOW, approvedById: OWNER.sub, status: 'APPROVED' },
      where: expect.objectContaining({
        id: PLAN_ID,
        ownerUserId: OWNER.sub,
        status: 'PENDING',
        teamId: 'team-1',
      }),
    });
  });

  it('answers another user exactly as a plan that does not exist, and changes nothing', async () => {
    const { prisma, table } = fakePrisma(planRow());
    const other = await approvePlan(deps(prisma), { sub: 'user-2' }, PLAN_ID);
    const absent = fakePrisma(null);
    const missing = await approvePlan(deps(absent.prisma), OWNER, PLAN_ID);
    expect(other).toMatchObject({ code: 'PLAN_NOT_FOUND', ok: false, status: 404 });
    expect(missing).toEqual(other);
    expect(table.plan?.status).toBe('PENDING');
    expect(prisma.runPlan.updateMany).not.toHaveBeenCalled();
  });

  it('is atomic: of two simultaneous approvals exactly one wins', async () => {
    const { prisma, table } = fakePrisma(planRow());
    const results = await Promise.all([
      approvePlan(deps(prisma), OWNER, PLAN_ID),
      approvePlan(deps(prisma), OWNER, PLAN_ID),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({ code: 'PLAN_NOT_PENDING', status: 409 });
    expect(table.plan?.status).toBe('APPROVED');
  });

  it('refuses a second approval after the first', async () => {
    const { prisma } = fakePrisma(planRow());
    await approvePlan(deps(prisma), OWNER, PLAN_ID);
    expect(await approvePlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_PENDING',
    });
  });

  it.each(['APPROVED', 'LAUNCHED', 'REJECTED', 'EXPIRED'])('refuses a %s plan', async (status) => {
    const { prisma } = fakePrisma(planRow({ status }));
    expect(await approvePlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_PENDING',
    });
  });

  it('refuses an expired plan and marks it EXPIRED', async () => {
    const { prisma, table } = fakePrisma(planRow({ expiresAt: new Date(NOW.getTime() - 1) }));
    expect(await approvePlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_EXPIRED',
    });
    expect(table.plan?.status).toBe('EXPIRED');
  });

  /** Every refusal below leaves the plan PENDING and never flips it. */
  const refusals: Array<[string, () => ReturnType<typeof fakePrisma>, string, (() => void)?]> = [
    [
      'a spec edited after creation (hash mismatch)',
      () => fakePrisma(planRow({ spec: { ...SPEC, name: 'edited' } })),
      'PLAN_TAMPERED',
    ],
    [
      'a plan that no longer meets the skeleton policy',
      () => fakePrisma(planRow()),
      'PLAN_POLICY_FAILED',
      () => {
        m.policy.ok = false;
        m.policy.errors = [{ code: 'CORE_MISMATCH' }];
      },
    ],
    [
      'a spec that no longer validates',
      () => {
        const spec = { ...SPEC, entry: 'missing' };
        return fakePrisma(planRow({ spec, specHash: hashRunPlanSpec(spec) }));
      },
      'PLAN_SPEC_INVALID',
    ],
    [
      'a catalog that changed since the plan was made',
      () => fakePrisma(planRow({ catalogHash: 'f'.repeat(64) })),
      'PLAN_CATALOG_CHANGED',
    ],
    [
      'an agent that moved to a new version',
      () => fakePrisma(planRow(), { agents: { implementer: 'GLOBAL:4' } }),
      'PLAN_AGENTS_CHANGED',
    ],
    [
      'an agent overridden at team scope since',
      () => fakePrisma(planRow(), { agents: { implementer: 'TEAM:1' } }),
      'PLAN_AGENTS_CHANGED',
    ],
    [
      'settings that changed since the plan was made',
      () => fakePrisma(planRow()),
      'PLAN_SETTINGS_CHANGED',
      () => {
        m.settings.value = { 'workflow.maxTransitions': 100 };
      },
    ],
    [
      'a repository that moved to another team',
      () =>
        fakePrisma(planRow(), {
          repo: {
            githubApiUrl: null,
            githubUrl: null,
            id: 'repo-1',
            organizationName: 'acme',
            repoName: 'api',
            team: { orgId: 'org-1' },
            teamId: 'team-2',
            type: 'git_repo',
          },
        }),
      'PLAN_REPOSITORY_CHANGED',
    ],
    [
      'a repository whose host is no longer approved',
      () => fakePrisma(planRow()),
      'REPO_HOST_NOT_ALLOWED',
      () => {
        m.hostsOk.value = false;
      },
    ],
    [
      'a user who lost the ENGINEER floor',
      () => fakePrisma(planRow(), { user: { id: 'user-1', isActive: true, role: 'VIEWER' } }),
      'FORBIDDEN',
    ],
    [
      'a deactivated user',
      () => fakePrisma(planRow(), { user: { id: 'user-1', isActive: false, role: 'ENGINEER' } }),
      'FORBIDDEN',
    ],
  ];

  it.each(refusals)('refuses %s, and flips nothing', async (_name, make, code, arrange) => {
    arrange?.();
    const { prisma, table } = make();
    const result = await approvePlan(deps(prisma), OWNER, PLAN_ID);
    expect(result).toMatchObject({ code, ok: false });
    expect(table.plan?.status).toBe('PENDING');
    expect(prisma.runPlan.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when the repository is no longer reachable by the owner', async () => {
    m.validate.mockImplementation(
      async (_i: unknown, reply: { status: (c: number) => { send: (b: unknown) => void } }) => {
        reply.status(404).send({ error: { code: 'CONNECTION_NOT_FOUND', message: 'gone' } });
        return { ok: false };
      }
    );
    const { prisma, table } = fakePrisma(planRow());
    expect(await approvePlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'CONNECTION_NOT_FOUND',
      status: 404,
    });
    expect(table.plan?.status).toBe('PENDING');
  });

  it('asks the approval quota hook before flipping, and stops on its refusal', async () => {
    const quotas: RunPlanQuotaPolicy = {
      checkApprove: vi.fn(async () => ({
        code: 'PLAN_QUOTA',
        message: 'budget',
        ok: false as const,
        status: 429,
      })),
      checkCreate: async () => null,
    };
    const { prisma, table } = fakePrisma(planRow());
    expect(await approvePlan(deps(prisma, { quotas }), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_QUOTA',
    });
    expect(table.plan?.status).toBe('PENDING');
  });
});

describe('rejectPlan', () => {
  it('rejects the owner’s pending plan, and an approved one that never launched', async () => {
    for (const status of ['PENDING', 'APPROVED']) {
      const { prisma, table } = fakePrisma(planRow({ status }));
      expect(await rejectPlan(deps(prisma), OWNER, PLAN_ID)).toEqual({ ok: true });
      expect(table.plan?.status).toBe('REJECTED');
    }
  });

  it('answers another user as not found and changes nothing', async () => {
    const { prisma, table } = fakePrisma(planRow());
    expect(await rejectPlan(deps(prisma), { sub: 'user-2' }, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    expect(table.plan?.status).toBe('PENDING');
  });

  it.each(['LAUNCHED', 'REJECTED', 'EXPIRED'])('cannot reject a %s plan', async (status) => {
    const { prisma, table } = fakePrisma(planRow({ status }));
    expect(await rejectPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_REJECTABLE',
    });
    expect(table.plan?.status).toBe(status);
  });
});

describe('expirePlans', () => {
  it('expires stale pending and approved plans and deletes old expired and rejected ones', async () => {
    const { prisma } = fakePrisma(planRow());
    prisma.runPlan.updateMany.mockResolvedValueOnce({ count: 3 });
    const result = await expirePlans(
      { now: () => NOW, prisma: prisma as never },
      { retentionMs: 1000 }
    );
    expect(result).toEqual({ deleted: 2, expired: 3 });
    expect(prisma.runPlan.updateMany).toHaveBeenCalledWith({
      data: { status: 'EXPIRED' },
      where: { expiresAt: { lte: NOW }, status: { in: ['PENDING', 'APPROVED'] } },
    });
    expect(prisma.runPlan.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date(NOW.getTime() - 1000) },
        status: { in: ['EXPIRED', 'REJECTED'] },
      },
    });
  });

  it('never touches a LAUNCHED plan', async () => {
    const { prisma } = fakePrisma(planRow());
    await expirePlans({ now: () => NOW, prisma: prisma as never });
    const touched = JSON.stringify([
      prisma.runPlan.updateMany.mock.calls,
      prisma.runPlan.deleteMany.mock.calls,
    ]);
    expect(touched).not.toContain('LAUNCHED');
  });
});

describe('launchApprovedPlan', () => {
  const approved = () => planRow({ approvedAt: NOW, approvedById: OWNER.sub, status: 'APPROVED' });

  it('starts the Planned Run template with only the plan id, as the approver', async () => {
    const { prisma } = fakePrisma(approved());
    const d = deps(prisma);
    const result = await launchApprovedPlan(d, OWNER, PLAN_ID);
    expect(result).toMatchObject({ ok: true, planId: PLAN_ID });
    const [, rows, start, options] = m.launch.mock.calls[0] as [
      unknown,
      { runInput: Record<string, unknown>; activeWorkflow: Record<string, unknown> },
      () => Promise<void>,
      { guard: (tx: unknown) => Promise<string | null> },
    ];
    expect(rows.runInput).toMatchObject({
      connectionId: 'repo-1',
      payload: { planId: PLAN_ID },
      requestedById: OWNER.sub,
      templateId: 'tpl-planned',
      templateVersion: 1,
      ticketIsSynthetic: true,
    });
    expect(rows.activeWorkflow.assignedBranch).toMatch(/^auto\/plan-/);
    await start();
    expect(d.temporal.startRunnableWorkflow).toHaveBeenCalledWith(
      expect.stringMatching(/^plan-/),
      expect.objectContaining({
        request: expect.objectContaining({
          launchedById: OWNER.sub,
          payload: { planId: PLAN_ID },
          trigger: 'planned-run',
          triggerRefId: PLAN_ID,
        }),
        templateId: 'tpl-planned',
      })
    );
    // The guard re-asserts, inside the ledger transaction, that the plan is still launchable.
    expect(
      await options.guard({ runPlan: { findFirst: async () => ({ id: PLAN_ID }) } })
    ).toBeNull();
    expect(await options.guard({ runPlan: { findFirst: async () => null } })).toBe(
      'PLAN_NOT_LAUNCHABLE'
    );
  });

  it('gives an output-only plan no work branch', async () => {
    const { prisma } = fakePrisma(planRow({ ...approved(), mode: 'output-only' }));
    await launchApprovedPlan(deps(prisma), OWNER, PLAN_ID);
    const rows = m.launch.mock.calls[0]?.[1] as { activeWorkflow: Record<string, unknown> };
    expect(rows.activeWorkflow.assignedBranch).toBeNull();
  });

  it('refuses a plan that is not APPROVED, one approved by someone else, and another user', async () => {
    const pending = fakePrisma(planRow());
    expect(await launchApprovedPlan(deps(pending.prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_APPROVED',
    });
    const foreign = fakePrisma(planRow({ ...approved(), approvedById: 'user-2' }));
    expect(await launchApprovedPlan(deps(foreign.prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_APPROVED',
    });
    const other = fakePrisma(approved());
    expect(await launchApprovedPlan(deps(other.prisma), { sub: 'user-2' }, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_FOUND',
    });
    expect(m.launch).not.toHaveBeenCalled();
  });

  it('refuses an expired approved plan', async () => {
    const { prisma } = fakePrisma(
      planRow({ ...approved(), expiresAt: new Date(NOW.getTime() - 1) })
    );
    expect(await launchApprovedPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_EXPIRED',
    });
    expect(m.launch).not.toHaveBeenCalled();
  });

  it('holds a library-agent plan to agent-run concurrency, and an engineering plan to none', async () => {
    m.slots.value = [
      { launchedAt: NOW, teamId: 'team-1', workflowId: 'w1' },
      { launchedAt: NOW, teamId: 'team-1', workflowId: 'w2' },
    ];
    const library = fakePrisma(
      planRow({ ...approved(), agentKey: 'docsMaintainer', mode: 'output-only' })
    );
    expect(await launchApprovedPlan(deps(library.prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'AGENT_RUN_CONCURRENCY_EXCEEDED',
      status: 429,
    });
    expect(m.launch).not.toHaveBeenCalled();
    const engineering = fakePrisma(approved());
    expect(await launchApprovedPlan(deps(engineering.prisma), OWNER, PLAN_ID)).toMatchObject({
      ok: true,
    });
  });

  it('answers a guard refusal or a duplicate as a conflict', async () => {
    const { prisma } = fakePrisma(approved());
    m.launch.mockResolvedValueOnce({ ok: false, reason: 'GUARD_REFUSED', refusal: 'x' });
    expect(await launchApprovedPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_NOT_LAUNCHABLE',
    });
    m.launch.mockResolvedValueOnce({ ok: false, reason: 'DUPLICATE', source: 'ledger' });
    expect(await launchApprovedPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'RUN_CONFLICT',
    });
  });
});

describe('approveAndLaunchPlan', () => {
  it('approves and launches', async () => {
    const { prisma, table } = fakePrisma(planRow());
    const result = await approveAndLaunchPlan(deps(prisma), OWNER, PLAN_ID);
    expect(result).toMatchObject({ ok: true });
    expect(table.plan?.status).toBe('APPROVED');
    expect(m.launch).toHaveBeenCalledTimes(1);
  });

  it('launches nothing when approval is refused', async () => {
    const { prisma } = fakePrisma(planRow({ spec: { ...SPEC, name: 'edited' } }));
    expect(await approveAndLaunchPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'PLAN_TAMPERED',
    });
    expect(m.launch).not.toHaveBeenCalled();
  });

  it('puts a plan back to PENDING when the launch is refused, so it can be approved again', async () => {
    m.launch.mockResolvedValueOnce({ ok: false, reason: 'DUPLICATE', source: 'ledger' });
    const { prisma, table } = fakePrisma(planRow());
    expect(await approveAndLaunchPlan(deps(prisma), OWNER, PLAN_ID)).toMatchObject({
      code: 'RUN_CONFLICT',
    });
    expect(table.plan).toMatchObject({ approvedById: null, status: 'PENDING' });
  });

  it('puts a plan back to PENDING when the launch throws, and rethrows', async () => {
    m.launch.mockRejectedValueOnce(new Error('temporal down'));
    const { prisma, table } = fakePrisma(planRow());
    await expect(approveAndLaunchPlan(deps(prisma), OWNER, PLAN_ID)).rejects.toThrow(
      'temporal down'
    );
    expect(table.plan?.status).toBe('PENDING');
  });

  it('does not revert a plan the worker already claimed', async () => {
    m.launch.mockImplementationOnce(async () => {
      // The worker claimed it between the launch and the refusal.
      Object.assign(table.plan as object, { launchedWorkflowRunId: 'run-1', status: 'LAUNCHED' });
      return { ok: false, reason: 'DUPLICATE', source: 'temporal' };
    });
    const { prisma, table } = fakePrisma(planRow());
    await approveAndLaunchPlan(deps(prisma), OWNER, PLAN_ID);
    expect(table.plan?.status).toBe('LAUNCHED');
  });
});
