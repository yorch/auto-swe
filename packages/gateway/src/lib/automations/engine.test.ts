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
vi.mock('../repositoryHost.js', () => ({
  webhookRepositoryWhere: vi.fn(async () => ({ organizationName: 'acme', repoName: 'api' })),
}));
vi.mock('../orgAccess.js', () => ({ isOrgOverBudget: vi.fn(async () => m.overBudget) }));

import {
  INBOUND_EVENT,
  WORKFLOW_RUN_FAILED,
  type WorkflowRunFailedFacts,
  workflowRunFailedSource,
} from '@auto-swe/shared/automation';
import { resolveSetting } from '@auto-swe/shared/config';
import { CI_TRIAGE_INPUT_SCHEMA } from '@auto-swe/shared/lib/ciTrigger';
import { FAKE_TEAM_SOURCE, fakeTeamSource } from '../../test/fakeTeamSource.js';
import { isOrgOverBudget } from '../orgAccess.js';
import {
  actorLaunchDecision,
  automationMatches,
  decideAndStart,
  decideUnderLock,
  handleOccurrence,
  ownerLockKey,
} from './engine.js';
import { handleInboundEvent, TARGET_UNAVAILABLE } from './inboundEvent.js';
import { normalizeWorkflowRunEvent } from './workflowRunFailed.js';

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

/** The failure as the tests describe it: flat, the way the CI handler used to take it. */
type Failed = WorkflowRunFailedFacts & {
  headBranch: string;
  org: string;
  repoName: string;
  repoFullName: string;
  repoHtmlUrl?: string;
};

const normalized = normalizeWorkflowRunEvent(body());
if (normalized.type !== 'failed') {
  throw new Error('fixture must be a failed run');
}
const failed: Failed = {
  ...normalized.facts,
  headBranch: normalized.facts.branch,
  org: normalized.org,
  repoFullName: normalized.repoFullName,
  repoHtmlUrl: normalized.repoHtmlUrl,
  repoName: normalized.repoName,
};

const occurrence = (e: Failed) => ({
  facts: {
    branch: e.headBranch,
    event: e.event,
    headSha: e.headSha,
    pullRequestNumber: e.pullRequestNumber,
    runAttempt: e.runAttempt,
    runId: e.runId,
    workflowPath: e.workflowPath,
  },
  org: e.org,
  repoFullName: e.repoFullName,
  repoHtmlUrl: e.repoHtmlUrl,
  repoName: e.repoName,
});

describe('automationMatches', () => {
  const rule = {
    enabled: true,
    filters: {
      branchPatterns: ['main', 'release/*'],
      events: ['push'],
      workflowPatterns: ['.github/workflows/ci.yml'],
    },
    source: WORKFLOW_RUN_FAILED,
  };
  const facts = occurrence(failed).facts;
  const with_ = (filters: Record<string, unknown>) => ({
    ...rule,
    filters: { ...rule.filters, ...filters },
  });

  it('matches on event, branch and workflow FILE path', () => {
    expect(automationMatches(workflowRunFailedSource, rule, facts)).toBe(true);
  });

  it('does not match a disabled rule, another source, event, branch or workflow', () => {
    const m_ = (r: typeof rule) => automationMatches(workflowRunFailedSource, r, facts);
    expect(m_({ ...rule, enabled: false })).toBe(false);
    expect(m_({ ...rule, source: 'github.issue.labeled' })).toBe(false);
    expect(m_(with_({ events: ['pull_request'] }))).toBe(false);
    expect(m_(with_({ branchPatterns: ['main'] }))).toBe(false);
    expect(m_(with_({ workflowPatterns: ['.github/workflows/lint.yml'] }))).toBe(false);
  });

  it('matches nothing when the stored filters do not parse', () => {
    expect(automationMatches(workflowRunFailedSource, with_({ branchPatterns: [] }), facts)).toBe(
      false
    );
    expect(
      automationMatches(workflowRunFailedSource, { ...rule, filters: 'all' as never }, facts)
    ).toBe(false);
  });
});

describe('the dedupe key', () => {
  it('names the run attempt on its repository, case-insensitively', () => {
    const facts = occurrence(failed).facts;
    expect(workflowRunFailedSource.dedupeKey('GitHub.com/Acme/API', facts)).toBe(
      'github.com/acme/api#123456789012/1'
    );
    expect(
      workflowRunFailedSource.dedupeKey('github.com/acme/api', { ...facts, runAttempt: 2 })
    ).not.toBe(workflowRunFailedSource.dedupeKey('github.com/acme/api', facts));
  });
});

// ── handleOccurrence against an in-memory database ───────────────────

interface Fire {
  id: string;
  dedupeKey: string;
  automationId: string;
  ownerKey: string;
  outcome: string;
  scopeKey: string;
  subjectKey: string;
  producedKey?: string | null;
  source: string;
  createdAt: Date;
  temporalWorkflowId?: string | null;
  reason?: string | null;
  retriedAt?: Date | null;
}

/** An automation, described flat; its event, branch and workflow lists become its filters. */
function trigger(over: Record<string, unknown> = {}) {
  const flat = {
    branchPatterns: ['release/*'],
    cooldownMinutes: 30,
    createdAt: new Date(0),
    enabled: true,
    events: ['push'],
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    inputs: { mode: 'fix' },
    maxRunsPerDay: 10,
    templateId: null,
    workflowPatterns: ['.github/workflows/**'],
    ...over,
  };
  const { branchPatterns, events, workflowPatterns, ...rest } = flat;
  return {
    ...rest,
    filters: { branchPatterns, events, workflowPatterns },
    source: WORKFLOW_RUN_FAILED,
  };
}

/** The connection the harness's `connection.findMany` returns, owned by `team-1`. */
const CONNECTION = 'cccccccc-0000-4000-8000-000000000001';
/** A connection no mocked row answers for: another team's, or none at all. */
const OTHER_CONNECTION = 'dddddddd-0000-4000-8000-000000000009';
/** A second connection the acting team owns, so a declared field can resolve to a real one. */
const DOC_CONNECTION = 'ffffffff-0000-4000-8000-00000000000f';
/** `CI_TRIAGE_INPUT_SCHEMA` plus one connection-typed option, for the reachability cases. */
const WITH_CONNECTION_INPUT = {
  ...CI_TRIAGE_INPUT_SCHEMA,
  properties: { ...CI_TRIAGE_INPUT_SCHEMA.properties, docConnectionId: { type: 'connection' } },
};

function harness(
  opts: {
    triggers?: ReturnType<typeof trigger>[];
    template?: unknown;
    /** Temporal's answer to "is this execution over?". */
    gone?: (id: string) => Promise<boolean>;
  } = {}
) {
  const fires: Fire[] = [];
  const active: Array<{ temporalWorkflowId: string; currentStatus: string }> = [];
  const started: Array<{ id: string; input: Record<string, unknown> }> = [];
  const runInputs: unknown[] = [];
  const triggers = opts.triggers ?? [trigger()];

  /** The subset of Prisma's `where` the decision uses, evaluated against a fire. */
  const matches = (f: Fire, where: Record<string, unknown>): boolean => {
    for (const key of [
      'id',
      'dedupeKey',
      'automationId',
      'ownerKey',
      'outcome',
      'subjectKey',
      'scopeKey',
      'producedKey',
      'source',
    ] as const) {
      const want = where[key];
      if (want !== null && typeof want === 'object' && 'not' in want) {
        if (f[key] === (want as { not: unknown }).not) {
          return false;
        }
      } else if (want !== undefined && f[key] !== want) {
        return false;
      }
    }
    if (where.createdAt && f.createdAt < (where.createdAt as { gte: Date }).gte) {
      return false;
    }
    if (where.temporalWorkflowId && !f.temporalWorkflowId) {
      return false;
    }
    return true;
  };

  const db = {
    $executeRaw: vi.fn(async (..._args: unknown[]) => 0),
    // The team knowledge-source snapshot of a run with no repository: no row, UNKNOWN source.
    $queryRaw: vi.fn(async (..._args: unknown[]) => []),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(db)),
    activeWorkflow: {
      create: vi.fn(
        async ({ data }: { data: { temporalWorkflowId: string; currentStatus: string } }) => {
          active.push(data);
          return { id: 'aw-1' };
        }
      ),
      delete: vi.fn(async () => ({})),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { temporalWorkflowId: { in: string[] }; currentStatus: { notIn: string[] } };
        }) =>
          active.filter(
            (a) =>
              where.temporalWorkflowId.in.includes(a.temporalWorkflowId) &&
              !where.currentStatus.notIn.includes(a.currentStatus)
          )
      ),
    },
    automationFire: {
      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          fires.filter((f) => matches(f, where)).length
      ),
      create: vi.fn(async ({ data }: { data: Omit<Fire, 'createdAt' | 'id'> }) => {
        if (fires.some((f) => f.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        fires.push({ ...data, createdAt: new Date(), id: `fire-${fires.length + 1}` });
        return data;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          fires.find((f) => matches(f, where)) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        fires.filter((f) => matches(f, where))
      ),
      updateMany: vi.fn(
        async ({ data, where }: { data: Partial<Fire>; where: Record<string, unknown> }) => {
          const hit = fires.filter((f) => matches(f, where));
          for (const f of hit) {
            Object.assign(f, data);
          }
          return { count: hit.length };
        }
      ),
    },
    connection: {
      // Honours `where.id.in`, which is how a declared-connection lookup asks: returning the
      // trigger's own row for any query would make every declared id resolve to the primary and
      // hide the positive non-primary path (the negative one only ever asks for a row that is
      // absent, so it would pass either way).
      findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
        const rows = [
          {
            automations: triggers,
            id: CONNECTION,
            installation: null,
            // Active, and owned outright: the shape `isRepoTeam` is asked about.
            isActive: true,
            shares: [],
            team: {
              id: 'team-1',
              organization: { id: 'org-1', monthlyBudgetUsdCents: null },
              orgId: 'org-1',
            },
            teamId: 'team-1',
            type: 'git_repo',
          },
          {
            // A second connection the team owns: what a payload field other than the run's own
            // target names, which is the case the reachability check exists for.
            id: DOC_CONNECTION,
            installation: null,
            isActive: true,
            shares: [],
            team: {
              id: 'team-1',
              organization: { id: 'org-1', monthlyBudgetUsdCents: null },
              orgId: 'org-1',
            },
            teamId: 'team-1',
            type: 'confluence',
          },
        ];
        const ids = where?.id?.in;
        // The engine's own lookup (no id filter) still sees exactly the trigger's row.
        return ids ? rows.filter((row) => ids.includes(row.id)) : [rows[0]];
      }),
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
          ? {
              activeVersion: 1,
              id: 'tttttttt-0000-4000-8000-000000000001',
              inputSchema: CI_TRIAGE_INPUT_SCHEMA,
            }
          : opts.template
      ),
    },
  };
  const fastify = {
    log: { error: vi.fn(), warn: vi.fn() },
    prisma: db,
    temporal: {
      isWorkflowGone: vi.fn(opts.gone ?? (async () => false)),
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

const handle = (h: ReturnType<typeof harness>, event: Failed = failed) =>
  handleOccurrence(
    h.fastify as never,
    workflowRunFailedSource,
    occurrence(event),
    null,
    new Date(),
    0
  );

describe('handleOccurrence (github.workflow_run.failed)', () => {
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
    // A repository run is billed through its connection, never a launch org.
    expect(h.runInputs[0]).toMatchObject({ billingOrgId: null });
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
      reason: 'no matching automation',
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
        trigger({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', inputs: {} }),
        trigger({ id: 'aaaaaaaa-0000-4000-8000-00000000000c' }),
      ],
    });
    const out = await handle(h);
    expect(out).toMatchObject({ automationId: 'aaaaaaaa-0000-4000-8000-00000000000b' });
    expect(
      (h.started[0]?.input.request as { payload: { mode: string } } | undefined)?.payload.mode
    ).toBe('triage');
  });

  it('counts only its own source’s decisions on the repository', async () => {
    const h = harness();
    h.fires.push({
      automationId: 'other',
      createdAt: new Date(),
      dedupeKey: 'x',
      id: 'fire-x',
      outcome: 'STARTED',
      ownerKey: 'github.com/acme/api',
      scopeKey: 'release/1.4',
      source: 'github.something.else',
      subjectKey: failed.headSha,
    });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
  });

  it('recognises its own pushed fix even after the repository was renamed', async () => {
    const h = harness();
    h.fires.push({
      automationId: 'a',
      createdAt: new Date(0),
      dedupeKey: 'y',
      id: 'fire-y',
      outcome: 'STARTED',
      ownerKey: 'github.com/acme/old-name',
      producedKey: failed.headSha,
      scopeKey: 'release/1.4',
      source: 'github.workflow_run.failed',
      subjectKey: 'b'.repeat(40),
    });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'SUPPRESSED_OWN_OUTPUT' });
  });

  it('remembers decisions after the automation is deleted and recreated', async () => {
    const h = harness();
    await handle(h);
    // The ledger is the repository's: a new automation with another id still sees the commit.
    const again = harness({ triggers: [trigger({ id: 'aaaaaaaa-0000-4000-8000-0000000000ff' })] });
    again.fires.push(...h.fires);
    await expect(handle(again, { ...failed, runId: '999' })).resolves.toMatchObject({
      outcome: 'SUPPRESSED_SAME_SUBJECT',
    });
  });

  it('never triages again a commit the platform pushed as a fix', async () => {
    const h = harness();
    await handle(h, { ...failed, headSha: 'f'.repeat(40), runId: '900' });
    // The run pushed its fix as commit 'e…e' onto the branch.
    (h.fires[0] as { producedKey?: string }).producedKey = 'e'.repeat(40);
    const out = await handle(h, { ...failed, headSha: 'e'.repeat(40), runId: '901' });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_OWN_OUTPUT' });
    expect(h.started).toHaveLength(1);
  });

  it('suppresses a second failure on the same commit', async () => {
    const h = harness({ triggers: [trigger({ cooldownMinutes: 0 })] });
    await handle(h);
    const out = await handle(h, {
      ...failed,
      runId: '999',
      workflowPath: '.github/workflows/lint.yml',
    });
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_SAME_SUBJECT' });
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
    expect(out).toMatchObject({ outcome: 'SUPPRESSED_PRECONDITION' });
    expect(h.started).toHaveLength(0);
  });

  it('sends every option explicitly: the trigger’s own over the template defaults', async () => {
    const h = harness({
      triggers: [trigger({ inputs: { maxCiFixAttempts: 0, minFixConfidence: 0.9, mode: 'fix' } })],
    });
    await handle(h);
    expect(
      (h.started[0]?.input.request as { payload: unknown } | undefined)?.payload
    ).toMatchObject({
      commentOnPullRequest: true,
      fixCategories: ['regression', 'test_bug', 'configuration', 'dependency'],
      maxCiFixAttempts: 0,
      minFixConfidence: 0.9,
      mode: 'fix',
    });
  });

  it('records FAILED_TO_START when the stored options no longer fit the template', async () => {
    const h = harness({ triggers: [trigger({ inputs: { mode: 'fix', retired: true } })] });
    await expect(handle(h)).resolves.toMatchObject({
      outcome: 'FAILED_TO_START',
      reason: expect.stringContaining("'retired' is not an option"),
    });
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

  it('records a failed start when every start attempt fails, and a redelivery takes it again', async () => {
    const h = harness();
    h.fastify.temporal.startRunnableWorkflow.mockRejectedValue(new Error('temporal down'));
    await expect(handle(h)).rejects.toMatchObject({ name: 'AutomationStartError' });
    expect(h.fastify.temporal.startRunnableWorkflow).toHaveBeenCalledTimes(3);
    expect(h.fires).toEqual([
      expect.objectContaining({ outcome: 'FAILED_TO_START', temporalWorkflowId: null }),
    ]);
    // Meanwhile another workflow fails on the same commit: the failed start does not count.
    h.fastify.temporal.startRunnableWorkflow.mockResolvedValue(undefined);
    await expect(
      handle(h, { ...failed, runId: '778', workflowPath: '.github/workflows/lint.yml' })
    ).resolves.toMatchObject({ outcome: 'STARTED' });
  });

  it('gives a failed start back when taking it again ends with no decision', async () => {
    const h = harness({ template: null });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
    const key = h.fires[0]?.dedupeKey;
    h.db.workflowTemplate.findFirst.mockRejectedValue(new Error('database down'));
    await expect(handle(h)).rejects.toThrow('database down');
    expect(h.fires).toEqual([
      expect.objectContaining({ dedupeKey: key, outcome: 'FAILED_TO_START', retriedAt: null }),
    ]);
  });

  it('takes a failed start again on redelivery, keeping the earlier decision marked retried', async () => {
    const h = harness({ template: null });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
    h.db.workflowTemplate.findFirst.mockResolvedValue({
      activeVersion: 1,
      id: 'tttttttt-0000-4000-8000-000000000001',
      inputSchema: CI_TRIAGE_INPUT_SCHEMA,
    } as never);
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    expect(h.fires).toHaveLength(2);
    const [old, fresh] = h.fires;
    expect(old).toMatchObject({ outcome: 'FAILED_TO_START', retriedAt: expect.any(Date) });
    expect(old?.dedupeKey).toBe(`${fresh?.dedupeKey}~${old?.id}`);
    // Any other decision stands: a redelivery of a started occurrence is a duplicate.
    await expect(handle(h)).resolves.toEqual({ duplicate: true });
  });

  it('starts one fix per commit even when two triggers match two failing workflows', async () => {
    const h = harness({
      triggers: [
        trigger({
          id: 'aaaaaaaa-0000-4000-8000-0000000000a1',
          workflowPatterns: ['.github/workflows/ci.yml'],
        }),
        trigger({
          id: 'aaaaaaaa-0000-4000-8000-0000000000a2',
          workflowPatterns: ['.github/workflows/lint.yml'],
        }),
      ],
    });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    const second = await handle(h, {
      ...failed,
      runId: '777',
      workflowPath: '.github/workflows/lint.yml',
    });
    expect(second).toMatchObject({
      automationId: 'aaaaaaaa-0000-4000-8000-0000000000a2',
      outcome: 'SUPPRESSED_SAME_SUBJECT',
    });
    expect(h.started).toHaveLength(1);
  });

  it('does not treat a run Temporal says is over as in flight, whatever its ledger row says', async () => {
    const h = harness({ gone: async () => true, triggers: [trigger({ cooldownMinutes: 0 })] });
    await handle(h);
    // The ledger row stays IMPLEMENTING, as for an execution terminated before it finalized.
    const next = await handle(h, { ...failed, headSha: 'b'.repeat(40), runId: '999' });
    expect(next).toMatchObject({ outcome: 'STARTED' });
  });

  it('counts a run as in flight when Temporal cannot answer', async () => {
    const h = harness({
      gone: async () => {
        throw new Error('temporal down');
      },
      triggers: [trigger({ cooldownMinutes: 0 })],
    });
    await handle(h);
    const next = await handle(h, { ...failed, headSha: 'b'.repeat(40), runId: '999' });
    expect(next).toMatchObject({ outcome: 'SUPPRESSED_IN_FLIGHT' });
  });

  it('retries a transient start failure before giving up', async () => {
    const h = harness();
    h.fastify.temporal.startRunnableWorkflow.mockRejectedValueOnce(new Error('unavailable'));
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    expect(h.fastify.temporal.startRunnableWorkflow).toHaveBeenCalledTimes(2);
  });

  it('takes "already started" on a retry as the earlier attempt having started it', async () => {
    const h = harness();
    h.fastify.temporal.startRunnableWorkflow
      .mockRejectedValueOnce(new Error('deadline exceeded'))
      .mockRejectedValueOnce(
        Object.assign(new Error('started'), { name: 'WorkflowExecutionAlreadyStartedError' })
      );
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    expect(h.fires[0]).toMatchObject({ outcome: 'STARTED' });
    expect(h.active).toHaveLength(1);
  });

  it('records FAILED_TO_START for a template that does not declare the CI payload', async () => {
    const h = harness({ template: { activeVersion: 1, id: 't', inputSchema: null } });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
    expect(h.started).toHaveLength(0);
  });

  it('refuses a fire whose payload names a connection the team cannot use', async () => {
    // The run's pin is derived from this same payload, so nothing downstream asks this question:
    // without the check the run is handed a connection its team was never authorized for.
    const h = harness({
      template: { activeVersion: 1, id: 't', inputSchema: WITH_CONNECTION_INPUT },
      triggers: [trigger({ inputs: { docConnectionId: OTHER_CONNECTION } })],
    });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
    expect(h.fires.at(-1)?.reason).toMatch(/not one this team can use/);
    expect(h.started).toHaveLength(0);
  });

  it('starts when every connection the payload names is the team’s', async () => {
    // `DOC_CONNECTION`, not the run's own `CONNECTION`: naming the primary would take the
    // `primaryConnectionId` skip, and `isRepoTeam` would never be asked.
    const h = harness({
      template: { activeVersion: 1, id: 't', inputSchema: WITH_CONNECTION_INPUT },
      triggers: [trigger({ inputs: { docConnectionId: DOC_CONNECTION } })],
    });
    await expect(handle(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    expect(h.started).toHaveLength(1);
    // And the check really ran, on the declared field: without it the assertion above still holds,
    // so this is what makes the case fail when the decision stops being made.
    expect(h.db.connection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [DOC_CONNECTION] } } })
    );
  });

  it('takes the per-repository lock before deciding', async () => {
    const h = harness();
    await handle(h);
    expect(h.db.$executeRaw).toHaveBeenCalled();
    // Byte for byte the lock earlier gateways take, so a rolling deploy serialises on it.
    expect(h.db.$executeRaw.mock.calls[0]?.[1]).toBe('automation-repo:github.com/acme/api');
  });
});

describe('owners that are not a repository', () => {
  const TEAM = {
    id: 'team-1',
    organization: { id: 'org-1', monthlyBudgetUsdCents: null },
    orgId: 'org-1',
  };
  const OWNER = '@team/team-1';
  const teamAutomation = {
    cooldownMinutes: 0,
    enabled: true,
    filters: { topics: ['deploys'] },
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    inputs: {},
    maxRunsPerDay: 10,
    source: FAKE_TEAM_SOURCE,
    templateId: null,
  };
  /** A template that needs no repository. */
  const repoless = {
    activeVersion: 1,
    id: 'tttttttt-0000-4000-8000-000000000002',
    inputSchema: {
      properties: { description: { type: 'string' }, ticketId: { type: 'string' } },
      required: [],
      type: 'object',
    },
    workspaceProvider: null,
  };
  const decide = (h: ReturnType<typeof harness>, eventId = 'e1') =>
    decideAndStart(h.fastify as never, fakeTeamSource, {
      automation: teamAutomation,
      connection: null,
      facts: { eventId, topic: 'deploys' },
      now: new Date(),
      ownerKey: OWNER,
      retry: { kind: 'redelivery' },
      startRetryDelayMs: 0,
      team: TEAM,
    });

  it('locks a repository by its old name and anything else under its own', () => {
    expect(ownerLockKey('github.com/acme/api')).toBe('automation-repo:github.com/acme/api');
    expect(ownerLockKey(OWNER)).toBe('automation-owner:@team/team-1');
  });

  it('starts a team automation’s run with no repository, recorded under its owner', async () => {
    const h = harness({ template: repoless });
    await expect(decide(h)).resolves.toMatchObject({ outcome: 'STARTED' });
    const request = h.started[0]?.input.request as Record<string, unknown>;
    expect(request).toMatchObject({ connectionId: null, repoId: null, workspaceProvider: null });
    expect(request.payload).not.toHaveProperty('connectionId');
    expect(h.fires[0]).toMatchObject({
      connectionId: null,
      dedupeKey: `${OWNER}#e1`,
      outcome: 'STARTED',
      ownerKey: OWNER,
    });
    expect(h.db.$executeRaw.mock.calls[0]?.[1]).toBe('automation-owner:@team/team-1');
    // Charged to the team's org, the org the budget decision read, so it is billed there.
    expect(h.runInputs[0]).toMatchObject({ billingOrgId: 'org-1', connectionId: null });
    // A redelivery of the same occurrence is decided once, on its owner.
    await expect(decide(h)).resolves.toEqual({ duplicate: true });
  });

  it('records FAILED_TO_START when a team automation’s template needs a repository', async () => {
    const h = harness({
      template: {
        ...repoless,
        inputSchema: {
          properties: { connectionId: { type: 'connection' }, description: { type: 'string' } },
          required: ['connectionId'],
          type: 'object',
        },
      },
    });
    await expect(decide(h)).resolves.toMatchObject({ outcome: 'FAILED_TO_START' });
    expect(h.started).toHaveLength(0);
    expect(h.fires[0]).toMatchObject({ outcome: 'FAILED_TO_START', ownerKey: OWNER });
  });

  it('matches own output within a non-repository owner only', async () => {
    const h = harness();
    const scope = {
      automation: { cooldownMinutes: 0, id: teamAutomation.id, maxRunsPerDay: 10 },
      ownerKey: OWNER,
    };
    const produced = (ownerKey: string) => ({
      automationId: 'x',
      createdAt: new Date(),
      dedupeKey: `${ownerKey}#p`,
      id: `fire-${ownerKey}`,
      outcome: 'STARTED',
      ownerKey,
      producedKey: 'e9',
      scopeKey: 'other',
      source: FAKE_TEAM_SOURCE,
      subjectKey: 'p',
    });
    const run = () =>
      decideUnderLock(
        h.db as never,
        scope,
        fakeTeamSource,
        { scope: 'deploys', subject: 'e9' },
        new Date(),
        async () => true
      );
    // Another team's output is not this team's.
    h.fires.push(produced('@team/team-2'));
    await expect(run()).resolves.toBeNull();
    h.fires.push(produced(OWNER));
    await expect(run()).resolves.toMatchObject({ outcome: 'SUPPRESSED_OWN_OUTPUT' });
  });

  it('derives a host for a person’s account only from a repository key', async () => {
    const findFirst = vi.fn(async (_args: unknown) => null);
    const prisma = { user: { findFirst } } as never;
    await expect(actorLaunchDecision(prisma, OWNER, '123', 'conn')).resolves.toHaveProperty(
      'refused'
    );
    // A sigil that looks like a host never names one.
    await actorLaunchDecision(prisma, '@endpoint/github.com', '123', 'conn');
    expect(findFirst).not.toHaveBeenCalled();
    await actorLaunchDecision(prisma, 'ghe.example.com/acme/api', '123', 'conn');
    expect(JSON.stringify(findFirst.mock.calls[0]?.[0])).toContain('ghe.example.com:123');
  });
});

describe('inbound events (inbound.event)', () => {
  const ENDPOINT = 'eeeeeeee-0000-4000-8000-000000000001';
  const TEAM = {
    id: 'team-1',
    organization: { id: 'org-1', monthlyBudgetUsdCents: null },
    orgId: 'org-1',
  };
  const template = {
    activeVersion: 1,
    id: 'tttttttt-0000-4000-8000-000000000003',
    inputSchema: {
      properties: {
        count: { type: 'number' },
        description: { type: 'string' },
        severity: { enum: ['low', 'high'], type: 'string' },
        ticketId: { type: 'string' },
      },
      required: [],
      type: 'object',
    },
    workspaceProvider: null,
  };
  const automation = (over: Record<string, unknown> = {}) => ({
    connectionId: null,
    cooldownMinutes: 0,
    createdAt: new Date(0),
    enabled: true,
    filters: {
      endpointId: ENDPOINT,
      eventTypes: ['alert.*'],
      fields: { severity: '/severity' },
      match: [{ op: 'eq', pointer: '/env', value: 'prod' }],
    },
    id: 'aaaaaaaa-0000-4000-8000-00000000000e',
    inputs: {},
    maxRunsPerDay: 10,
    source: INBOUND_EVENT,
    targetConnectionId: null,
    teamId: 'team-1',
    templateId: template.id,
    ...over,
  });
  const event = (document: Record<string, unknown>, id = 'evt-1') => ({
    document,
    endpointId: ENDPOINT,
    id,
    scope: 'alert.fired',
    subject: id,
    type: 'alert.fired',
  });
  function withAutomations(rows: unknown[], over: { template?: unknown } = {}) {
    const h = harness({ template: over.template ?? template });
    Object.assign(h.db, {
      automation: { findMany: vi.fn(async () => rows) },
      connection: { ...h.db.connection, findFirst: vi.fn(async () => null) },
    });
    return h;
  }
  const handleEvent = (h: ReturnType<typeof harness>, doc: Record<string, unknown>, id?: string) =>
    handleInboundEvent(
      h.fastify as never,
      { id: ENDPOINT, team: TEAM, teamId: 'team-1' },
      event(doc, id),
      new Date(),
      0
    );

  it('refuses at fire a mapping the template has since retyped to a connection input', async () => {
    // The save-time check refuses a mapping onto a `connection` input, but it ran when the
    // mapping was *stored*. A template that retypes the field afterwards would otherwise let the
    // event's own sender pick which of the team's connections the run uses: an occurrence's fields
    // win over the automation's options, and the run's pin is derived from that same payload.
    const h = withAutomations([automation()], {
      template: {
        ...template,
        inputSchema: {
          ...template.inputSchema,
          properties: { ...template.inputSchema.properties, severity: { type: 'connection' } },
        },
      },
    });

    await expect(handleEvent(h, { env: 'prod', severity: CONNECTION })).resolves.toMatchObject({
      outcome: 'FAILED_TO_START',
    });

    expect(h.fires.at(-1)?.reason).toMatch(/cannot fill/);
    expect(h.started).toHaveLength(0);
  });

  it('starts one run per event, keyed and locked on the endpoint, however many automations match', async () => {
    const second = automation({ id: 'aaaaaaaa-0000-4000-8000-00000000000f' });
    const h = withAutomations([automation(), second]);
    const result = await handleEvent(h, { env: 'prod', severity: 'high', text: 'x'.repeat(10) });
    expect(result).toMatchObject({ automationId: automation().id, outcome: 'STARTED' });
    expect(h.started).toHaveLength(1);
    expect(h.fires[0]).toMatchObject({
      connectionId: null,
      dedupeKey: `@endpoint/${ENDPOINT}#evt-1`,
      ownerKey: `@endpoint/${ENDPOINT}`,
      scopeKey: 'alert.fired',
      subjectKey: 'evt-1',
    });
    expect(h.db.$executeRaw.mock.calls[0]?.[1]).toBe(`automation-owner:@endpoint/${ENDPOINT}`);
    // Only the extracted values are recorded, never the payload.
    expect(
      h.fires[0] && JSON.stringify((h.fires[0] as unknown as { facts: unknown }).facts)
    ).not.toContain('xxxxxxxxxx');
    const request = h.started[0]?.input.request as {
      payload: Record<string, unknown>;
      description: string;
    };
    expect(request.payload.severity).toBe('high');
    expect(request.description).toContain('no person asked for it');
    // The same event again, whichever automation would match it, is decided once.
    await expect(handleEvent(h, { env: 'prod', severity: 'high' })).resolves.toEqual({
      duplicate: true,
    });
    expect(h.started).toHaveLength(1);
  });

  it('ignores an event no automation selects, recording nothing', async () => {
    const h = withAutomations([automation()]);
    await expect(handleEvent(h, { env: 'staging' })).resolves.toMatchObject({ ignored: true });
    expect(h.fires).toHaveLength(0);
  });

  it('ignores every event while the kill switch is off', async () => {
    m.enabled = false;
    const h = withAutomations([automation()]);
    await expect(handleEvent(h, { env: 'prod' })).resolves.toMatchObject({ ignored: true });
    expect(h.fires).toHaveLength(0);
  });

  it('records FAILED_TO_START when a mapped value does not fit the template', async () => {
    const h = withAutomations([automation()]);
    const result = await handleEvent(h, { env: 'prod', severity: 'catastrophic' });
    expect(result).toMatchObject({ outcome: 'FAILED_TO_START' });
    expect(h.fires[0]?.reason).toContain("'severity' must be one of");
    expect(h.started).toHaveLength(0);
  });

  it('records FAILED_TO_START when its repository is no longer the team’s', async () => {
    const h = withAutomations([
      automation({ targetConnectionId: 'cccccccc-0000-4000-8000-0000000000ff' }),
    ]);
    const result = await handleEvent(h, { env: 'prod', severity: 'low' });
    expect(result).toMatchObject({ outcome: 'FAILED_TO_START', reason: TARGET_UNAVAILABLE });
    expect(h.started).toHaveLength(0);
  });

  /** A repository another team (another organization) owns and shares with this one. */
  function sharedTarget(h: ReturnType<typeof harness>) {
    (h.db.connection as unknown as { findFirst: ReturnType<typeof vi.fn> }).findFirst = vi.fn(
      async () => ({
        id: 'cccccccc-0000-4000-8000-000000000002',
        installation: null,
        team: {
          id: 'team-2',
          organization: { id: 'org-2', monthlyBudgetUsdCents: 100 },
          orgId: 'org-2',
        },
        teamId: 'team-2',
      })
    );
  }

  it('suppresses a run on a shared repository whose own team has inbound events off', async () => {
    const h = withAutomations([
      automation({ targetConnectionId: 'cccccccc-0000-4000-8000-000000000002' }),
    ]);
    sharedTarget(h);
    vi.mocked(resolveSetting).mockImplementation(
      (async (_key: string, ctx: { teamId?: string }) => ctx.teamId !== 'team-2') as never
    );
    try {
      const result = await handleEvent(h, { env: 'prod', severity: 'low' });
      expect(result).toMatchObject({ outcome: 'SUPPRESSED_PRECONDITION' });
      expect(h.fires[0]?.reason).toContain('switched off for the repository’s team');
      expect(h.started).toHaveLength(0);
    } finally {
      vi.mocked(resolveSetting).mockImplementation((async () => m.enabled) as never);
    }
  });

  it('suppresses a run on a shared repository whose organization is over budget', async () => {
    const h = withAutomations([
      automation({ targetConnectionId: 'cccccccc-0000-4000-8000-000000000002' }),
    ]);
    sharedTarget(h);
    vi.mocked(isOrgOverBudget).mockImplementation(async (_p, orgId) => orgId === 'org-2');
    try {
      const result = await handleEvent(h, { env: 'prod', severity: 'low' });
      expect(result).toMatchObject({
        outcome: 'SUPPRESSED_BUDGET',
        reason: 'the repository’s organization is over its monthly budget',
      });
      expect(h.started).toHaveLength(0);
      // With budget, the same event starts on the shared repository.
      vi.mocked(isOrgOverBudget).mockImplementation(async () => false);
      const again = await handleEvent(h, { env: 'prod', severity: 'low' }, 'evt-2');
      expect(again).toMatchObject({ outcome: 'STARTED' });
    } finally {
      vi.mocked(isOrgOverBudget).mockImplementation(async () => m.overBudget);
    }
  });

  it('acts on a target repository with its id in the payload', async () => {
    const h = withAutomations([
      automation({ targetConnectionId: 'cccccccc-0000-4000-8000-000000000001' }),
    ]);
    (h.db.connection as unknown as { findFirst: ReturnType<typeof vi.fn> }).findFirst = vi.fn(
      async () => ({
        id: 'cccccccc-0000-4000-8000-000000000001',
        installation: null,
        team: TEAM,
        teamId: 'team-2',
      })
    );
    await expect(handleEvent(h, { env: 'prod', severity: 'low' })).resolves.toMatchObject({
      outcome: 'STARTED',
    });
    const request = h.started[0]?.input.request as Record<string, unknown>;
    expect(request).toMatchObject({
      connectionId: 'cccccccc-0000-4000-8000-000000000001',
      workspaceProvider: 'git_repo',
    });
    // Still decided on the endpoint, not the repository.
    expect(h.fires[0]?.ownerKey).toBe(`@endpoint/${ENDPOINT}`);
  });
});
