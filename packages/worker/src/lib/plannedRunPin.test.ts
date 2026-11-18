import { PLANNED_RUN_SPEC } from '@auto-swe/shared/lib/plannedRun';
import { hashRunPlanSpec } from '@auto-swe/shared/workflow/runPlan';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const policy = vi.hoisted(() => ({ errors: [] as Array<{ code: string }>, ok: true }));
const access = vi.hoisted(() => ({
  gate: { value: { mode: 'off' } as unknown },
  verdict: { value: { allowed: true, reason: 'permitted' } as unknown },
}));
vi.mock('@auto-swe/shared/lib/repoAccessDecision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessDecision')>()),
  decideRepoAccess: vi.fn(async () => access.verdict.value),
}));
vi.mock('@auto-swe/shared/lib/repoAccessGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/repoAccessGate')>()),
  resolveRepoAccessGateOrLastKnown: vi.fn(async () => access.gate.value),
}));
vi.mock('@auto-swe/shared/workflow/runPlan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/workflow/runPlan')>()),
  // The policy itself is covered by its own suites; here only that the pin consults it, with the
  // plan's mode. The real policy is exercised by the "real policy" case below.
  checkSkeletonPolicy: vi.fn(() => ({ errors: policy.errors, ok: policy.ok })),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string, details?: unknown) =>
      Object.assign(new Error(message), { details, nonRetryable: true, type }),
  },
  log: { warn: () => undefined },
}));

import { checkSkeletonPolicy } from '@auto-swe/shared/workflow/runPlan';
import {
  assertLauncherStillAuthorized,
  claimPlanWithRun,
  loadApprovedPlan,
  PLANNED_RUN_REFUSAL_TYPE,
  type PlannedRunPinInput,
} from './plannedRunPin.js';

const PLAN_ID = '0b1c2d3e-0000-4000-8000-000000000001';
const USER = 'user-1';
const REPO = 'repo-1';
const NOW = new Date('2026-11-17T12:00:00Z');

const SPEC = {
  description: '',
  entry: 'a',
  name: 'plan',
  nodes: { a: { status: 'SUCCESS', type: 'terminate' } },
  schemaVersion: 1,
};

function planRow(over: Record<string, unknown> = {}) {
  return {
    agentPins: { implementer: 'GLOBAL:3' },
    approvedById: USER,
    connectionId: REPO,
    expiresAt: new Date(NOW.getTime() + 60_000),
    id: PLAN_ID,
    launchedWorkflowRunId: null,
    mode: 'delivering',
    ownerUserId: USER,
    scrubbedAt: null,
    spec: SPEC,
    specHash: hashRunPlanSpec(SPEC),
    status: 'APPROVED',
    teamId: 'team-1',
    ...over,
  };
}

interface DbOpts {
  existingRun?: string;
  user?: unknown;
  repo?: unknown;
  orgMember?: boolean;
  /** Extra agent rows the stand-in knows, as `key@scope:version`-style entries. */
  agents?: Array<{ key: string; scope: string; version: number; workflowTemplateId?: string }>;
}

function dbWith(plan: Record<string, unknown> | null, opts: DbOpts = {}) {
  const agents = [{ key: 'implementer', scope: 'GLOBAL', version: 3 }, ...(opts.agents ?? [])];
  return {
    agent: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { key: string; scope: string; version?: number; workflowTemplateId?: string };
        }) => {
          const hit = agents
            .filter(
              (a) =>
                a.key === where.key &&
                a.scope === where.scope &&
                (where.version === undefined || a.version === where.version) &&
                (where.workflowTemplateId === undefined ||
                  a.workflowTemplateId === where.workflowTemplateId)
            )
            .sort((x, y) => y.version - x.version)[0];
          return hit ? { ...hit, inheritsModelFrom: null, modelSpec: 'a/b' } : null;
        }
      ),
    },
    connection: {
      findUnique: vi.fn(async () =>
        opts.repo === undefined
          ? {
              id: REPO,
              isActive: true,
              shares: [],
              team: {
                isActive: true,
                memberships: [{ userId: USER }],
                organization: { isActive: true },
                orgId: 'org-1',
              },
              teamId: 'team-1',
            }
          : opts.repo
      ),
    },
    organizationMembership: {
      findUnique: vi.fn(async () => (opts.orgMember === false ? null : { userId: USER })),
    },
    runPlan: { findUnique: vi.fn(async () => plan) },
    user: {
      findUnique: vi.fn(async () =>
        opts.user === undefined ? { id: USER, isActive: true, role: 'ENGINEER' } : opts.user
      ),
    },
    workflowRun: {
      findUnique: vi.fn(async () => (opts.existingRun ? { id: opts.existingRun } : null)),
    },
  } as never;
}

const input = (over: Partial<PlannedRunPinInput> = {}): PlannedRunPinInput => ({
  launchedById: USER,
  payload: { planId: PLAN_ID },
  runConnectionId: REPO,
  workflowId: 'plan-run-1',
  ...over,
});
const scope = { orgId: 'org-1', teamId: 'team-1' };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const e = err as Error & { nonRetryable?: boolean; type?: string };
    expect(e.nonRetryable).toBe(true);
    expect(e.type).toBe(PLANNED_RUN_REFUSAL_TYPE);
    return e.message.split(':')[0] as string;
  }
  return 'NO_REFUSAL';
}

beforeEach(() => {
  access.gate.value = { mode: 'off' };
  access.verdict.value = { allowed: true, reason: 'permitted' };
  policy.ok = true;
  policy.errors = [];
  vi.mocked(checkSkeletonPolicy).mockClear();
});

describe('loadApprovedPlan', () => {
  it('returns the approved plan spec, parsed, with nothing claimed yet', async () => {
    const pinned = await loadApprovedPlan(input(), scope, NOW, dbWith(planRow()));
    expect(pinned).toMatchObject({
      claimedByRunId: null,
      mode: 'delivering',
      planId: PLAN_ID,
      teamId: 'team-1',
    });
    expect(pinned.spec.name).toBe('plan');
    // Re-checked at pin time, with the plan's own mode.
    expect(checkSkeletonPolicy).toHaveBeenCalledWith(expect.anything(), 'delivering');
  });

  it.each([
    ['an extra payload field', { payload: { planId: PLAN_ID, spec: {} } }, 'PLAN_PAYLOAD_INVALID'],
    ['a payload that is not a plan id', { payload: { planId: 'x' } }, 'PLAN_PAYLOAD_INVALID'],
    ['no payload', { payload: undefined }, 'PLAN_PAYLOAD_INVALID'],
    ['no launcher', { launchedById: undefined }, 'PLAN_NO_LAUNCHER'],
    ['a launcher who is not the approver', { launchedById: 'user-2' }, 'PLAN_APPROVER_MISMATCH'],
    ['another repository', { runConnectionId: 'repo-2' }, 'PLAN_REPOSITORY_MISMATCH'],
    ['no repository', { runConnectionId: null }, 'PLAN_REPOSITORY_MISMATCH'],
  ])('refuses %s', async (_name, over, code) => {
    expect(
      await codeOf(loadApprovedPlan(input(over as never), scope, NOW, dbWith(planRow())))
    ).toBe(code);
  });

  it('refuses a plan that does not exist', async () => {
    expect(await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(null)))).toBe(
      'PLAN_NOT_FOUND'
    );
  });

  it('refuses a scrubbed plan with a non-retryable PLAN_SCRUBBED, ahead of every other check', async () => {
    const scrubbed = planRow({
      scrubbedAt: new Date('2026-09-01T00:00:00Z'),
      spec: {},
      specHash: 'scrubbed',
      status: 'LAUNCHED',
    });
    expect(await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(scrubbed)))).toBe(
      'PLAN_SCRUBBED'
    );
  });

  it.each(['PENDING', 'REJECTED', 'EXPIRED', 'LAUNCHED'])('refuses a %s plan', async (status) => {
    expect(await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ status }))))).toBe(
      'PLAN_NOT_APPROVED'
    );
  });

  it('refuses a plan whose approval is missing, or by another person', async () => {
    for (const approvedById of [null, 'user-2']) {
      expect(
        await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ approvedById }))))
      ).toBe('PLAN_APPROVER_MISMATCH');
    }
  });

  it('refuses a plan owned by someone else even when the approver is the launcher', async () => {
    expect(
      await codeOf(
        loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ ownerUserId: 'user-2' })))
      )
    ).toBe('PLAN_OWNER_MISMATCH');
  });

  it('refuses an expired plan, including one that expires exactly now', async () => {
    for (const expiresAt of [new Date(NOW.getTime() - 1), NOW]) {
      expect(
        await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ expiresAt }))))
      ).toBe('PLAN_EXPIRED');
    }
  });

  it('refuses a spec edited after approval (hash mismatch)', async () => {
    const tampered = { ...SPEC, nodes: { a: { status: 'FAILED', type: 'terminate' } } };
    expect(
      await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ spec: tampered }))))
    ).toBe('PLAN_SPEC_TAMPERED');
  });

  it('refuses a stored spec that does not parse', async () => {
    const broken = { nope: true };
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(planRow({ spec: broken, specHash: hashRunPlanSpec(broken) }))
        )
      )
    ).toBe('PLAN_SPEC_INVALID');
  });

  it('refuses a plan with an unknown mode', async () => {
    expect(
      await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ mode: 'free' }))))
    ).toBe('PLAN_MODE_INVALID');
  });

  it('refuses when the skeleton policy now fails', async () => {
    policy.ok = false;
    policy.errors = [{ code: 'CORE_MISMATCH' }];
    const rejected = loadApprovedPlan(input(), scope, NOW, dbWith(planRow()));
    expect(await codeOf(rejected)).toBe('PLAN_POLICY_FAILED');
  });

  it('refuses a spec that fails validateSpec even when the policy passes', async () => {
    const dangling = { ...SPEC, entry: 'missing' };
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(planRow({ spec: dangling, specHash: hashRunPlanSpec(dangling) }))
        )
      )
    ).toBe('PLAN_SPEC_INVALID');
  });

  it('refuses when a pinned agent moved to another version', async () => {
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(planRow({ agentPins: { implementer: 'GLOBAL:2' } }))
        )
      )
    ).toBe('PLAN_AGENT_DRIFT');
  });

  it('refuses when a pinned agent is gone', async () => {
    expect(
      await codeOf(
        loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ agentPins: { ghost: 'GLOBAL:1' } })))
      )
    ).toBe('PLAN_AGENT_DRIFT');
  });

  it('refuses when the spec names an agent the plan never pinned', async () => {
    const spec = {
      ...SPEC,
      entry: 'ask',
      nodes: {
        a: { status: 'SUCCESS', type: 'terminate' },
        ask: { agentRef: 'implementer', next: 'a', type: 'agent' },
      },
    };
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(planRow({ agentPins: {}, spec, specHash: hashRunPlanSpec(spec) }))
        )
      )
    ).toBe('PLAN_AGENT_DRIFT');
  });

  it('refuses a workflow id that another run already holds', async () => {
    expect(
      await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow(), { existingRun: 'r9' })))
    ).toBe('PLAN_WORKFLOW_ID_REUSED');
  });

  describe('a Temporal retry of the attempt that already claimed the plan', () => {
    const claimed = () => planRow({ launchedWorkflowRunId: 'run-1', status: 'LAUNCHED' });

    it('is recognised by the plan being LAUNCHED by the run row under this workflow id', async () => {
      const pinned = await loadApprovedPlan(
        input(),
        scope,
        NOW,
        dbWith(claimed(), { existingRun: 'run-1' })
      );
      expect(pinned.claimedByRunId).toBe('run-1');
      // Not re-judged: the run was admitted once, and its agents are already pinned on the row.
      expect(checkSkeletonPolicy).not.toHaveBeenCalled();
    });

    it('is not recognised for a plan LAUNCHED by some other run', async () => {
      expect(
        await codeOf(
          loadApprovedPlan(input(), scope, NOW, dbWith(claimed(), { existingRun: 'run-2' }))
        )
      ).toBe('PLAN_NOT_APPROVED');
    });

    it('still refuses another launcher and a tampered spec', async () => {
      expect(
        await codeOf(
          loadApprovedPlan(
            input({ launchedById: 'user-2' }),
            scope,
            NOW,
            dbWith(claimed(), { existingRun: 'run-1' })
          )
        )
      ).toBe('PLAN_APPROVER_MISMATCH');
      expect(
        await codeOf(
          loadApprovedPlan(
            input(),
            scope,
            NOW,
            dbWith({ ...claimed(), spec: { ...SPEC, name: 'edited' } }, { existingRun: 'run-1' })
          )
        )
      ).toBe('PLAN_SPEC_TAMPERED');
    });
  });
});

describe('loadApprovedPlan: what the plan runs and who runs it', () => {
  const specWith = (nodes: Record<string, unknown>, entry: string) => ({
    ...SPEC,
    entry,
    nodes: { done: { status: 'SUCCESS', type: 'terminate' }, ...nodes },
  });
  const withSpec = (spec: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    planRow({ spec, specHash: hashRunPlanSpec(spec), ...over });

  it('pins the agents a step node resolves: a core of steps drifts when a step-reached agent moves', async () => {
    const spec = specWith(
      { impl: { next: 'done', step: 'executeImplementation', type: 'step' } },
      'impl'
    );
    // The plan recorded only the implementer, but the step also runs the post-diff security gate.
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(withSpec(spec, { agentPins: { implementer: 'GLOBAL:3' } })),
          vi.fn()
        )
      )
    ).toBe('PLAN_AGENT_DRIFT');
    // With the gate agent present and recorded, the same plan pins.
    const pinned = await loadApprovedPlan(
      input(),
      scope,
      NOW,
      dbWith(
        withSpec(spec, { agentPins: { implementer: 'GLOBAL:3', securityReview: 'GLOBAL:2' } }),
        { agents: [{ key: 'securityReview', scope: 'GLOBAL', version: 2 }] }
      ),
      vi.fn()
    );
    expect(pinned.planId).toBe(PLAN_ID);
  });

  it('counts a template-scoped override of a pinned agent as drift', async () => {
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          { ...scope, workflowTemplateId: 'tpl-planned' },
          NOW,
          dbWith(planRow(), {
            agents: [
              {
                key: 'implementer',
                scope: 'WORKFLOW_TEMPLATE',
                version: 1,
                workflowTemplateId: 'tpl-planned',
              },
            ],
          }),
          vi.fn()
        )
      )
    ).toBe('PLAN_AGENT_DRIFT');
  });

  it('pins the version a key@N node references and refuses when that version is gone', async () => {
    const spec = specWith({ ask: { agentRef: 'writer@2', next: 'done', type: 'agent' } }, 'ask');
    const row = withSpec(spec, {
      agentKey: 'writer',
      agentPins: { 'writer@2': 'GLOBAL:2' },
      mode: 'output-only',
    });
    const there = dbWith(row, {
      agents: [
        { key: 'writer', scope: 'GLOBAL', version: 2 },
        { key: 'writer', scope: 'GLOBAL', version: 4 },
      ],
    });
    expect((await loadApprovedPlan(input(), scope, NOW, there, vi.fn())).planId).toBe(PLAN_ID);
    const gone = dbWith(row, { agents: [{ key: 'writer', scope: 'GLOBAL', version: 4 }] });
    expect(await codeOf(loadApprovedPlan(input(), scope, NOW, gone, vi.fn()))).toBe(
      'PLAN_AGENT_DRIFT'
    );
  });

  it.each([
    ['an output-only plan that names no agent', { agentKey: null, mode: 'output-only' }],
    ['a delivering plan that names an agent', { agentKey: 'writer', mode: 'delivering' }],
    [
      'an output-only plan whose spec does not run its agent',
      { agentKey: 'other', mode: 'output-only' },
    ],
  ])('refuses %s', async (_name, over) => {
    const spec = specWith({ ask: { agentRef: 'writer', next: 'done', type: 'agent' } }, 'ask');
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(withSpec(spec, { agentPins: {}, ...over }), {
            agents: [{ key: 'writer', scope: 'GLOBAL', version: 1 }],
          }),
          vi.fn()
        )
      )
    ).toBe('PLAN_AGENT_MISMATCH');
  });

  it('answers a spec nested past the canonicalizer with a code, not an error', async () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 150; i++) {
      deep = { n: deep };
    }
    expect(
      await codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow({ spec: deep })), vi.fn()))
    ).toBe('PLAN_SPEC_TOO_DEEP');
  });

  describe('the launcher is judged again at pin time', () => {
    const run = (opts: DbOpts) =>
      codeOf(loadApprovedPlan(input(), scope, NOW, dbWith(planRow(), opts)));

    it('pins for a launcher who still has access (the real check, stubbed GitHub gate)', async () => {
      expect((await loadApprovedPlan(input(), scope, NOW, dbWith(planRow()))).planId).toBe(PLAN_ID);
    });

    it('refuses a deactivated launcher', async () => {
      expect(await run({ user: { id: USER, isActive: false, role: 'ENGINEER' } })).toBe(
        'PLAN_LAUNCHER_INACTIVE'
      );
      expect(await run({ user: null })).toBe('PLAN_LAUNCHER_INACTIVE');
    });

    it('refuses a launcher demoted below ENGINEER', async () => {
      expect(await run({ user: { id: USER, isActive: true, role: 'VIEWER' } })).toBe(
        'PLAN_LAUNCHER_ROLE'
      );
    });

    it('refuses when the shared repository decision no longer allows the launcher', async () => {
      access.verdict.value = { allowed: false, reason: 'not-a-team-member' };
      expect(await run({})).toBe('PLAN_LAUNCHER_ACCESS_LOST');
    });

    it('refuses a launcher who left the organization, and an inactive repository or team', async () => {
      expect(await run({ orgMember: false })).toBe('PLAN_LAUNCHER_ACCESS_LOST');
      expect(await run({ repo: null })).toBe('PLAN_REPOSITORY_INACTIVE');
      expect(
        await run({
          repo: {
            id: REPO,
            isActive: true,
            shares: [],
            team: {
              isActive: false,
              memberships: [],
              organization: { isActive: true },
              orgId: 'o',
            },
          },
        })
      ).toBe('PLAN_REPOSITORY_INACTIVE');
    });

    it('fails closed when the access policy cannot be read', async () => {
      access.gate.value = null;
      expect(await run({})).toBe('PLAN_ACCESS_UNREADABLE');
    });

    it('does not ask again on a Temporal retry of the attempt that already claimed', async () => {
      const claimed = planRow({ launchedWorkflowRunId: 'run-1', status: 'LAUNCHED' });
      const pinned = await loadApprovedPlan(
        input(),
        scope,
        NOW,
        dbWith(claimed, { existingRun: 'run-1', user: null })
      );
      expect(pinned.claimedByRunId).toBe('run-1');
    });

    it('exposes the check on its own', async () => {
      await expect(
        assertLauncherStillAuthorized(dbWith(null, { user: null }), USER, REPO)
      ).rejects.toMatchObject({ type: PLANNED_RUN_REFUSAL_TYPE });
    });
  });
});

describe('loadApprovedPlan with the real skeleton policy', () => {
  it('refuses the placeholder spec as a delivering plan: it has no canonical core', async () => {
    const { checkSkeletonPolicy: real } = await vi.importActual<
      typeof import('@auto-swe/shared/workflow/runPlan')
    >('@auto-swe/shared/workflow/runPlan');
    vi.mocked(checkSkeletonPolicy).mockImplementation(real);
    const spec = JSON.parse(JSON.stringify(PLANNED_RUN_SPEC));
    expect(
      await codeOf(
        loadApprovedPlan(
          input(),
          scope,
          NOW,
          dbWith(planRow({ spec, specHash: hashRunPlanSpec(spec) }))
        )
      )
    ).toBe('PLAN_POLICY_FAILED');
  });
});

describe('claimPlanWithRun', () => {
  const pinned = (claimedByRunId: string | null = null) => ({
    claimedByRunId,
    mode: 'delivering' as const,
    planId: PLAN_ID,
    spec: SPEC as never,
    teamId: 'team-1',
  });

  function txDb(count: number) {
    const tx = {
      runPlan: { updateMany: vi.fn(async () => ({ count })) },
      workflowRun: { upsert: vi.fn(async () => ({ id: 'run-1' })) },
    };
    return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)), tx };
  }

  it('writes the run row, then claims APPROVED -> LAUNCHED for that row, scoped to the plan team', async () => {
    const { $transaction, tx } = txDb(1);
    const run = await claimPlanWithRun(pinned(), { create: {} }, { $transaction } as never);
    expect(run).toEqual({ id: 'run-1' });
    expect(tx.runPlan.updateMany).toHaveBeenCalledWith({
      data: { launchedWorkflowRunId: 'run-1', status: 'LAUNCHED' },
      where: { id: PLAN_ID, status: 'APPROVED', teamId: 'team-1' },
    });
  });

  it('refuses the loser of two racing launches: the transaction throws and takes its row along', async () => {
    const { $transaction } = txDb(0);
    await expect(
      claimPlanWithRun(pinned(), { create: {} }, { $transaction } as never)
    ).rejects.toThrow(/PLAN_ALREADY_LAUNCHED/);
  });

  it('claims nothing for a retry of the attempt that already did', async () => {
    const { $transaction, tx } = txDb(0);
    await claimPlanWithRun(pinned('run-1'), { create: {} }, { $transaction } as never);
    expect(tx.runPlan.updateMany).not.toHaveBeenCalled();
    expect(tx.workflowRun.upsert).toHaveBeenCalledTimes(1);
  });
});
