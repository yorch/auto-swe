import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  enabled: true,
  overBudget: false,
}));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async () => m.enabled),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));
vi.mock('./repositoryHost.js', () => ({
  webhookRepositoryWhere: vi.fn(async () => ({ organizationName: 'acme', repoName: 'api' })),
}));
vi.mock('./orgAccess.js', () => ({ isOrgOverBudget: vi.fn(async () => m.overBudget) }));

import {
  fireDedupeKey,
  handleWorkflowRunFailure,
  normalizeWorkflowRunEvent,
  triggerMatches,
  type WorkflowRunFailedEvent,
} from './ciFailureTriggers.js';

const REPO_ID = 42;

function body(over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) {
  return {
    action: 'completed',
    repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api', id: REPO_ID },
    workflow_run: {
      conclusion: 'failure',
      event: 'push',
      head_branch: 'release/1.4',
      head_repository: { full_name: 'acme/api', id: REPO_ID },
      head_sha: 'a'.repeat(40),
      id: 123456789012,
      path: '.github/workflows/ci.yml',
      pull_requests: [],
      run_attempt: 1,
      status: 'completed',
      ...run,
    },
    ...over,
  };
}

describe('normalizeWorkflowRunEvent', () => {
  it('maps a failed push run', () => {
    expect(normalizeWorkflowRunEvent(body())).toMatchObject({
      event: 'push',
      headBranch: 'release/1.4',
      org: 'acme',
      pullRequestNumber: null,
      repoName: 'api',
      runAttempt: 1,
      runId: '123456789012',
      type: 'failed',
      workflowPath: '.github/workflows/ci.yml',
    });
  });

  it.each([
    ['a run that has not completed', body({ action: 'requested' })],
    ['a passing run', body({}, { conclusion: 'success' })],
    ['a cancelled run', body({}, { conclusion: 'cancelled' })],
    ['a startup failure (no logs)', body({}, { conclusion: 'startup_failure' })],
    ['pull_request_target', body({}, { event: 'pull_request_target' })],
    ['a schedule', body({}, { event: 'schedule' })],
    ['workflow_dispatch', body({}, { event: 'workflow_dispatch' })],
    ['merge_group', body({}, { event: 'merge_group' })],
    ['a fork', body({}, { head_repository: { full_name: 'mallory/api', id: 7 } })],
    [
      'a fork renamed to the same name',
      body({}, { head_repository: { full_name: 'acme/api', id: 7 } }),
    ],
    ['a deleted fork', body({}, { head_repository: null })],
    ['no branch', body({}, { head_branch: null })],
    ['a branch name that is not safe', body({}, { head_branch: '-x' })],
  ])('ignores %s', (_label, payload) => {
    expect(normalizeWorkflowRunEvent(payload).type).toBe('ignored');
  });

  it('is unrecognized for another shape', () => {
    expect(normalizeWorkflowRunEvent({ check_run: {} }).type).toBe('unrecognized');
  });

  it('finds the same-repository pull request from the failing branch', () => {
    const pr = (n: number, ref: string, repoId: number) => ({
      base: { ref: 'main', repo: { id: REPO_ID } },
      head: { ref, repo: { id: repoId } },
      number: n,
    });
    const event = normalizeWorkflowRunEvent(
      body(
        {},
        {
          event: 'pull_request',
          head_branch: 'feat/x',
          pull_requests: [pr(1, 'other', REPO_ID), pr(2, 'feat/x', 99), pr(3, 'feat/x', REPO_ID)],
        }
      )
    );
    expect(event).toMatchObject({ pullRequestNumber: 3, type: 'failed' });
  });

  it('has no pull request when GitHub lists none', () => {
    const event = normalizeWorkflowRunEvent(
      body({}, { event: 'pull_request', head_branch: 'feat/x' })
    );
    expect(event).toMatchObject({ pullRequestNumber: null, type: 'failed' });
  });
});

const failed = normalizeWorkflowRunEvent(body()) as WorkflowRunFailedEvent;

describe('triggerMatches', () => {
  const rule = {
    branchPatterns: ['main', 'release/*'],
    enabled: true,
    events: ['push'],
    workflowPatterns: ['.github/workflows/ci.yml'],
  };

  it('matches on event, branch and workflow FILE path', () => {
    expect(triggerMatches(rule, failed)).toBe(true);
  });

  it('does not match a disabled rule, another event, branch or workflow', () => {
    expect(triggerMatches({ ...rule, enabled: false }, failed)).toBe(false);
    expect(triggerMatches({ ...rule, events: ['pull_request'] }, failed)).toBe(false);
    expect(triggerMatches({ ...rule, branchPatterns: ['main'] }, failed)).toBe(false);
    expect(
      triggerMatches({ ...rule, workflowPatterns: ['.github/workflows/lint.yml'] }, failed)
    ).toBe(false);
  });
});

describe('fireDedupeKey', () => {
  it('names the run attempt on its host, case-insensitively', () => {
    expect(fireDedupeKey('GitHub.com', { ...failed, repoFullName: 'Acme/API' })).toBe(
      'github.com/acme/api#123456789012/1'
    );
    expect(fireDedupeKey('github.com', { ...failed, runAttempt: 2 })).not.toBe(
      fireDedupeKey('github.com', failed)
    );
  });
});

// ── handleWorkflowRunFailure against an in-memory database ───────────────────

interface Fire {
  dedupeKey: string;
  triggerId: string;
  outcome: string;
  headBranch: string;
  headSha: string;
  createdAt: Date;
  temporalWorkflowId?: string | null;
  reason?: string | null;
}

function trigger(over: Record<string, unknown> = {}) {
  return {
    branchPatterns: ['release/*'],
    commentOnPullRequest: true,
    cooldownMinutes: 30,
    createdAt: new Date(0),
    enabled: true,
    events: ['push'],
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    maxRunsPerDay: 10,
    mode: 'FIX',
    templateId: null,
    workflowPatterns: ['.github/workflows/**'],
    ...over,
  };
}

function harness(opts: { triggers?: ReturnType<typeof trigger>[]; template?: unknown } = {}) {
  const fires: Fire[] = [];
  const active: Array<{ temporalWorkflowId: string; currentStatus: string }> = [];
  const started: Array<{ id: string; input: Record<string, unknown> }> = [];
  const runInputs: unknown[] = [];
  const db = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
    activeWorkflow: {
      create: vi.fn(
        async ({ data }: { data: { temporalWorkflowId: string; currentStatus: string } }) => {
          active.push(data);
          return { id: 'aw-1' };
        }
      ),
      delete: vi.fn(async () => ({})),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { temporalWorkflowId: { in: string[] }; currentStatus: { notIn: string[] } };
        }) =>
          active.find(
            (a) =>
              where.temporalWorkflowId.in.includes(a.temporalWorkflowId) &&
              !where.currentStatus.notIn.includes(a.currentStatus)
          ) ?? null
      ),
    },
    ciFailureTriggerFire: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: { triggerId: string; outcome: string; createdAt: { gte: Date } };
        }) =>
          fires.filter(
            (f) =>
              f.triggerId === where.triggerId &&
              f.outcome === where.outcome &&
              f.createdAt >= where.createdAt.gte
          ).length
      ),
      create: vi.fn(async ({ data }: { data: Omit<Fire, 'createdAt'> }) => {
        if (fires.some((f) => f.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        fires.push({ ...data, createdAt: new Date() });
        return data;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { dedupeKey: string } }) => {
        const i = fires.findIndex((f) => f.dedupeKey === where.dedupeKey);
        if (i >= 0) {
          fires.splice(i, 1);
        }
        return { count: 1 };
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          fires.find(
            (f) =>
              f.triggerId === where.triggerId &&
              f.outcome === where.outcome &&
              (where.headSha === undefined || f.headSha === where.headSha) &&
              (where.headBranch === undefined || f.headBranch === where.headBranch) &&
              (where.createdAt === undefined ||
                f.createdAt >= (where.createdAt as { gte: Date }).gte)
          ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { triggerId: string; headBranch: string } }) =>
        fires.filter(
          (f) =>
            f.triggerId === where.triggerId &&
            f.outcome === 'STARTED' &&
            f.headBranch === where.headBranch &&
            f.temporalWorkflowId
        )
      ),
    },
    connection: {
      findMany: vi.fn(async () => [
        {
          ciFailureTriggers: opts.triggers ?? [trigger()],
          id: 'cccccccc-0000-4000-8000-000000000001',
          installation: null,
          team: {
            id: 'team-1',
            organization: { id: 'org-1', monthlyBudgetUsdCents: null },
            orgId: 'org-1',
          },
          teamId: 'team-1',
        },
      ]),
    },
    runInput: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        runInputs.push(data);
        return data;
      }),
      delete: vi.fn(async () => ({})),
    },
    workflowTemplate: {
      findFirst: vi.fn(async () =>
        opts.template === undefined
          ? { activeVersion: 1, id: 'tttttttt-0000-4000-8000-000000000001', inputSchema: null }
          : opts.template
      ),
    },
  };
  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma: db,
    temporal: {
      startRunnableWorkflow: vi.fn(async (id: string, input: Record<string, unknown>) => {
        started.push({ id, input });
      }),
    },
  };
  return { active, db, fastify, fires, runInputs, started };
}

beforeEach(() => {
  m.enabled = true;
  m.overBudget = false;
});

const handle = (h: ReturnType<typeof harness>, event: WorkflowRunFailedEvent = failed) =>
  handleWorkflowRunFailure(h.fastify as never, event, null);

describe('handleWorkflowRunFailure', () => {
  it('starts one triage run targeting the failing branch, by run id, as a synthetic ticket', async () => {
    const h = harness();
    const out = await handle(h);
    expect(out).toMatchObject({ outcome: 'STARTED' });
    expect(h.started).toHaveLength(1);
    const request = h.started[0]?.input.request as Record<string, unknown>;
    expect(request.payload).toMatchObject({
      baseBranch: 'release/1.4',
      githubRunId: '123456789012',
      mode: 'fix',
      runAttempt: 1,
    });
    expect(JSON.stringify(request.payload)).not.toContain('http');
    expect(h.runInputs[0]).toMatchObject({ requestedById: null, ticketIsSynthetic: true });
    expect(request).not.toHaveProperty('launchedById');
    expect(h.fires).toHaveLength(1);
    expect(h.fires[0]).toMatchObject({ outcome: 'STARTED' });
  });

  it('starts nothing for a redelivery of the same run attempt', async () => {
    const h = harness();
    await handle(h);
    await expect(handle(h)).resolves.toEqual({ duplicate: true });
    expect(h.started).toHaveLength(1);
  });

  it('ignores the platform’s own work branches', async () => {
    const h = harness({ triggers: [trigger({ branchPatterns: ['**'] })] });
    const out = await handle(h, { ...failed, headBranch: 'auto/ci-1-1' });
    expect(out).toMatchObject({ ignored: true });
    expect(h.started).toHaveLength(0);
  });

  it('ignores a failure no trigger matches, and records nothing', async () => {
    const h = harness({ triggers: [trigger({ branchPatterns: ['main'] })] });
    await expect(handle(h)).resolves.toMatchObject({
      ignored: true,
      reason: 'no matching trigger',
    });
    expect(h.fires).toHaveLength(0);
  });

  it('honours the kill switch', async () => {
    m.enabled = false;
    const h = harness();
    await expect(handle(h)).resolves.toMatchObject({ ignored: true });
    expect(h.started).toHaveLength(0);
  });

  it('uses the first matching trigger only', async () => {
    const h = harness({
      triggers: [
        trigger({ branchPatterns: ['main'], id: 'aaaaaaaa-0000-4000-8000-00000000000a' }),
        trigger({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', mode: 'TRIAGE_ONLY' }),
        trigger({ id: 'aaaaaaaa-0000-4000-8000-00000000000c' }),
      ],
    });
    const out = await handle(h);
    expect(out).toMatchObject({ triggerId: 'aaaaaaaa-0000-4000-8000-00000000000b' });
    expect(
      (h.started[0]?.input.request as { payload: { mode: string } } | undefined)?.payload.mode
    ).toBe('triage');
  });

  it('suppresses a second failure on the same commit', async () => {
    const h = harness({ triggers: [trigger({ cooldownMinutes: 0 })] });
    await handle(h);
    const out = await handle(h, {
      ...failed,
      runId: '999',
      workflowPath: '.github/workflows/lint.yml',
    });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_SAME_COMMIT' });
    expect(h.started).toHaveLength(1);
  });

  it('suppresses a new commit on the same branch within the cooldown', async () => {
    const h = harness();
    await handle(h);
    const out = await handle(h, { ...failed, headSha: 'b'.repeat(40), runId: '999' });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_COOLDOWN' });
  });

  it('suppresses while an earlier run on the branch is still in flight', async () => {
    const h = harness({ triggers: [trigger({ cooldownMinutes: 0 })] });
    await handle(h);
    const out = await handle(h, { ...failed, headSha: 'b'.repeat(40), runId: '999' });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_IN_FLIGHT' });
    // Once that run is over, the next failure starts a run.
    (h.active[0] as { currentStatus: string }).currentStatus = 'COMPLETED';
    const next = await handle(h, { ...failed, headSha: 'c'.repeat(40), runId: '1000' });
    expect(next).toMatchObject({ outcome: 'STARTED' });
  });

  it('suppresses past the daily cap', async () => {
    const h = harness({ triggers: [trigger({ cooldownMinutes: 0, maxRunsPerDay: 1 })] });
    await handle(h);
    (h.active[0] as { currentStatus: string }).currentStatus = 'COMPLETED';
    const out = await handle(h, {
      ...failed,
      headBranch: 'release/2',
      headSha: 'b'.repeat(40),
      runId: '9',
    });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_DAILY_CAP' });
  });

  it('records a pull-request failure with no open pull request, and starts nothing', async () => {
    const h = harness({ triggers: [trigger({ events: ['pull_request'] })] });
    const out = await handle(h, { ...failed, event: 'pull_request', pullRequestNumber: null });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_NO_PULL_REQUEST' });
    expect(h.started).toHaveLength(0);
  });

  it('carries the pull request and the comment choice for a pull-request failure', async () => {
    const h = harness({ triggers: [trigger({ events: ['pull_request'] })] });
    await handle(h, { ...failed, event: 'pull_request', pullRequestNumber: 7 });
    expect(
      (h.started[0]?.input.request as { payload: unknown } | undefined)?.payload
    ).toMatchObject({
      commentOnPullRequest: true,
      pullRequestNumber: 7,
    });
  });

  it('suppresses when the organization is over budget', async () => {
    m.overBudget = true;
    const h = harness();
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'SUPPRESSED_BUDGET' });
    expect(h.started).toHaveLength(0);
  });

  it('records FAILED_TO_START when the template is missing', async () => {
    const h = harness({ template: null });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
  });

  it('forgets the decision when the workflow cannot start, so a redelivery can retry', async () => {
    const h = harness();
    h.fastify.temporal.startRunnableWorkflow.mockRejectedValueOnce(new Error('temporal down'));
    await expect(handle(h)).rejects.toMatchObject({ name: 'CiTriggerStartError' });
    expect(h.fires).toHaveLength(0);
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
  });

  it('takes the per-trigger lock before deciding', async () => {
    const h = harness();
    await handle(h);
    expect(h.db.$executeRaw).toHaveBeenCalled();
  });
});
