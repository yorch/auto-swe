import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `submitPrdWorkRequests` hands every PRD story a child run. That child's
 * identity decides which scoped knowledge it may read and capture, so the
 * launcher must travel from the exact parent execution to every child
 * independently of the per-user GitHub-credential setting — the setting governs
 * which credential is sent, never who the run acts as.
 *
 * The real `runLauncher.currentRunLauncherId` is deliberately left unmocked: the
 * fake `activityInfo` below provides this execution's id and the fake
 * `WorkflowRun` row provides its launcher, so the exact-execution binding is
 * exercised rather than assumed.
 *
 * `state.rows` models persisted child requests keyed by the deterministic primary key (the real
 * unique constraint), and `state.runs` models `WorkflowRun` rows keyed by the request they were
 * created from. Production writes a `WorkflowRun` row when the child runs its own first activity —
 * that, not an `ActiveWorkflow` link, is the durable "this child was launched" signal.
 *
 * `state.holders` are the ledger rows written with each child request, keyed by workflow id.
 */
const state = vi.hoisted(() => ({
  activityRunId: 'temporal-run-1',
  // Temporal executions that closed after being accepted, by workflow id.
  closed: new Set<string>(),
  credentialPolicy: { enabled: false } as { enabled: boolean } | null,
  describe: vi.fn(),
  // Temporal executions by workflow id: what a start call observes and leaves behind.
  executions: new Map<string, 'OPEN'>(),
  // Ledger rows written by the child transaction, by workflow id.
  holders: new Map<string, { workRequestId: string }>(),
  launcherRow: { launchedById: 'user-launcher', temporalRunId: 'temporal-run-1' } as {
    launchedById: string | null;
    temporalRunId: string | null;
  },
  resolveUserCredentialPolicy: vi.fn(),
  rows: new Map<string, { requestPayload: string }>(),
  runInputCreate: vi.fn(),
  runs: new Map<string, { workflowId: string }>(),
  start: vi.fn(),
}));

const REPO = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

vi.mock('@temporalio/activity', () => ({
  activityInfo: () => ({
    attempt: 1,
    workflowExecution: { runId: state.activityRunId, workflowId: 'prd-wf-1' },
  }),
  heartbeat: vi.fn(),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: readonly string[], fn: () => unknown) => fn(),
}));

// Kept mocked even though `prdWorkflow` must no longer read the credential
// policy: if a credential-gated launcher read is ever reintroduced, the test
// exercises it in its disabled state instead of failing on an unmocked module.
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  resolveUserCredentialPolicy: state.resolveUserCredentialPolicy,
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: async () => null,
  resolveKnowledgeBaseConfig: async () => ({ provider: null, spaces: [] }),
}));

vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: () => null,
}));

vi.mock('@auto-swe/shared/lib/trackerWrite', () => ({
  createTrackerEpic: vi.fn(),
  createTrackerStory: vi.fn(),
}));

vi.mock('../lib/config/agentSpec.js', () => ({ resolveAgentSpec: vi.fn() }));
vi.mock('../lib/config/contextLookup.js', () => ({ currentRequestContext: vi.fn() }));
vi.mock('../lib/execUtils.js', () => ({ withHeartbeat: (_name: string, run: unknown) => run }));
vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));
vi.mock('./templates.js', () => ({
  // The real class is substituted, not the real module: `prdWorkflow` matches
  // this error with `instanceof`, so the mock must export the same binding.
  NoTemplateForRepoError: class NoTemplateForRepoError extends Error {},
  resolveTemplateForRepo: vi.fn(async () => ({ templateId: 'tpl-1', templateVersion: 1 })),
}));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({
    workflow: {
      getHandle: (workflowId: string) => ({ describe: () => state.describe(workflowId) }),
      start: state.start,
    },
  }),
}));
vi.mock('../lib/workflowIdAllocation.js', () => ({
  allocateTicketWorkflowId: vi.fn(async () => ({ workflowId: 'eng-acme-api-PRD-1' })),
}));

vi.mock('@auto-swe/shared/db', () => {
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: 'locked-row' }]),
    $transaction: vi.fn((arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => unknown)(prisma);
      }
      return Promise.all(arg as unknown[]);
    }),
    activeWorkflow: {
      findFirst: vi.fn(
        async ({ where }: { where: { temporalWorkflowId?: string; workRequestId?: string } }) => {
          if (where.workRequestId) {
            for (const [workflowId, row] of state.holders) {
              if (row.workRequestId === where.workRequestId) {
                return { temporalWorkflowId: workflowId, workRequestId: row.workRequestId };
              }
            }
            return null;
          }
          const holder = where.temporalWorkflowId
            ? state.holders.get(where.temporalWorkflowId)
            : null;
          return holder ?? null;
        }
      ),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(
        async ({ where }: { where: { temporalWorkflowId: string } }) =>
          state.holders.get(where.temporalWorkflowId) ?? null
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(
        async ({
          create,
          where,
        }: {
          create: { temporalWorkflowId: string; workRequestId: string };
          where: { temporalWorkflowId: string };
        }) => {
          // `update: {}`: an existing row keeps its own request.
          if (!state.holders.has(where.temporalWorkflowId)) {
            state.holders.set(create.temporalWorkflowId, {
              workRequestId: create.workRequestId,
            });
          }
          return {};
        }
      ),
    },
    connection: {
      findMany: vi.fn(async () => [
        {
          githubUrl: 'https://github.com/acme/api',
          id: REPO,
          isActive: true,
          organizationName: 'acme',
          repoName: 'api',
          team: { isActive: true, organization: { isActive: true }, orgId: ORG },
          teamId: TEAM,
        },
      ]),
      findUnique: vi.fn(async ({ select }: { select?: Record<string, unknown> }) => {
        if (select && 'isActive' in select) {
          return {
            id: REPO,
            isActive: true,
            shares: [],
            team: {
              id: TEAM,
              isActive: true,
              memberships: [{ userId: 'user-launcher' }],
              organization: { isActive: true },
              orgId: ORG,
            },
            teamId: TEAM,
            type: 'git_repo',
          };
        }
        return { shares: [], team: { orgId: ORG }, teamId: TEAM };
      }),
    },
    organizationMembership: {
      findUnique: vi.fn(async () => ({ userId: 'user-launcher' })),
    },
    runInput: {
      create: state.runInputCreate,
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = state.rows.get(where.id);
        return row ? { requestPayload: row.requestPayload } : null;
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        knowledgeRepoSources: [{ orgId: ORG, repoId: REPO, teamId: TEAM }],
        requestPayload: JSON.stringify({
          connectionId: REPO,
          prdContent: 'PRD body',
          prdTitle: 'PRD title',
          repoIds: [REPO],
        }),
      })),
    },
    user: {
      findUnique: vi.fn(async () => ({
        id: 'user-launcher',
        isActive: true,
        role: 'ENGINEER',
      })),
    },
    workflowRun: {
      findFirst: vi.fn(async ({ where }: { where: { workRequestId: string } }) =>
        state.runs.has(where.workRequestId) ? { id: 'workflow-run-row' } : null
      ),
      findUnique: vi.fn(async () => state.launcherRow),
    },
  };
  return { prisma };
});

import { allocateTicketWorkflowId } from '../lib/workflowIdAllocation.js';
import { prdChildWorkRequestId, submitPrdWorkRequests } from './prdWorkflow.js';
import { NoTemplateForRepoError, resolveTemplateForRepo } from './templates.js';

const DECOMPOSITION = {
  epics: [
    {
      description: 'Epic description',
      stories: [
        {
          acceptanceCriteria: ['It works'],
          dependencies: [],
          description: 'Story description',
          storyPoints: 3,
          title: 'Story one',
        },
      ],
      title: 'Epic one',
    },
  ],
  rationale: 'Because.',
};

function childRequest(): Record<string, unknown> {
  expect(state.start).toHaveBeenCalledTimes(1);
  const [, options] = state.start.mock.calls[0] as [
    string,
    { args: [{ request: Record<string, unknown> }] },
  ];
  return options.args[0].request;
}

const PRD_REQUEST = '44444444-4444-4444-8444-444444444444';
const PRD_REQUEST_B = '55555555-5555-4555-8555-555555555555';

const REQUEST = { repoId: REPO, workRequestId: PRD_REQUEST } as never;

function run() {
  return submitPrdWorkRequests(REQUEST, { decomposition: DECOMPOSITION });
}

/** The same submission shape for a different PRD request, to check separation. */
function runFor(workRequestId: string) {
  return submitPrdWorkRequests({ repoId: REPO, workRequestId } as never, {
    decomposition: DECOMPOSITION,
  });
}

/** The same submission, with a tracker item that gives story one a shared ticket id. */
function runWithTrackerTicket() {
  return submitPrdWorkRequests(REQUEST, {
    decomposition: DECOMPOSITION,
    trackerItems: {
      createdItems: [{ id: 'JIRA-1', title: 'Story one', type: 'story' }],
      failedCount: 0,
    },
  });
}

describe('submitPrdWorkRequests child launcher propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps a `mockResolvedValueOnce` queue that was never
    // consumed, so a test that failed early would otherwise leak its one-shot
    // value into the next test. Restore every default the module relied on.
    vi.mocked(allocateTicketWorkflowId).mockReset();
    vi.mocked(allocateTicketWorkflowId).mockResolvedValue({
      workflowId: 'eng-acme-api-PRD-1',
    } as never);
    vi.mocked(resolveTemplateForRepo).mockReset();
    vi.mocked(resolveTemplateForRepo).mockResolvedValue({
      templateId: 'tpl-1',
      templateVersion: 1,
    });
    state.activityRunId = 'temporal-run-1';
    state.launcherRow = { launchedById: 'user-launcher', temporalRunId: 'temporal-run-1' };
    state.credentialPolicy = { enabled: false };
    state.resolveUserCredentialPolicy.mockImplementation(async () => state.credentialPolicy);
    state.runInputCreate.mockReset();
    // Model the primary key: a second write of the same deterministic id is the
    // P2002 the activity's idempotency path is built on.
    state.runInputCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      const id = data.id as string;
      if (state.rows.has(id)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate key', {
          clientVersion: 'test',
          code: 'P2002',
        });
      }
      state.rows.set(id, { requestPayload: data.requestPayload as string });
      return { id };
    });
    state.rows.clear();
    state.runs.clear();
    state.holders.clear();
    state.executions.clear();
    state.closed.clear();
    state.describe.mockReset();
    state.describe.mockImplementation(async (workflowId: string) => {
      if (state.executions.has(workflowId)) {
        return { status: { name: 'RUNNING' } };
      }
      if (state.closed.has(workflowId)) {
        return { status: { name: 'COMPLETED' } };
      }
      throw new WorkflowNotFoundError(`workflow ${workflowId} not found`, workflowId, undefined);
    });
    state.start.mockReset();
    // Temporal refuses to reuse an id while that execution is open, and a start that
    // is accepted leads — once the child runs — to its `WorkflowRun` row.
    state.start.mockImplementation(
      async (
        _workflowType: string,
        options: { workflowId: string; args: [{ request: { workRequestId: string } }] }
      ) => {
        if (state.executions.has(options.workflowId)) {
          class WorkflowExecutionAlreadyStartedError extends Error {}
          throw new WorkflowExecutionAlreadyStartedError('already started');
        }
        state.executions.set(options.workflowId, 'OPEN');
        state.runs.set(options.args[0].request.workRequestId, { workflowId: options.workflowId });
      }
    );
  });

  it('gives the child the parent execution launcher even with per-user credentials disabled', async () => {
    await submitPrdWorkRequests({ repoId: REPO, workRequestId: 'prd-request-1' } as never, {
      decomposition: DECOMPOSITION,
    });

    expect(state.credentialPolicy).toEqual({ enabled: false });
    expect(childRequest().launchedById).toBe('user-launcher');
  });

  it('gives the child the parent execution launcher with per-user credentials enabled', async () => {
    state.credentialPolicy = { enabled: true };
    await submitPrdWorkRequests({ repoId: REPO, workRequestId: 'prd-request-1' } as never, {
      decomposition: DECOMPOSITION,
    });

    expect(childRequest().launchedById).toBe('user-launcher');
  });

  it('persists the child knowledge source for the same launcher that the child acts as', async () => {
    await submitPrdWorkRequests({ repoId: REPO, workRequestId: 'prd-request-1' } as never, {
      decomposition: DECOMPOSITION,
    });

    expect(state.runInputCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        knowledgeSourceKind: 'REPOSITORY',
        knowledgeSourceOrgId: ORG,
        knowledgeSourceRepoId: REPO,
        knowledgeSourceTeamId: TEAM,
      }),
    });
    expect(childRequest().launchedById).toBe('user-launcher');
  });

  it('omits the launcher when the parent execution has none', async () => {
    state.launcherRow = { launchedById: null, temporalRunId: 'temporal-run-1' };
    await submitPrdWorkRequests({ repoId: REPO, workRequestId: 'prd-request-1' } as never, {
      decomposition: DECOMPOSITION,
    });

    expect(childRequest().launchedById).toBeUndefined();
  });

  it('does not inherit a launcher from a stale execution row for a reused workflow id', async () => {
    state.launcherRow = {
      launchedById: 'user-from-earlier-execution',
      temporalRunId: 'temporal-run-0',
    };
    await run();

    expect(childRequest().launchedById).toBeUndefined();
    expect(state.runInputCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ knowledgeSourceKind: 'UNKNOWN' }),
    });
  });

  it('fails the activity instead of reporting a work request when the child write fails', async () => {
    // A lost connection, lock timeout, deadlock or failed source check is not a
    // duplicate. Reporting one would return an ID with no row and no child run.
    state.runInputCreate.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(run()).rejects.toThrow('connection terminated unexpectedly');
    expect(state.start).not.toHaveBeenCalled();
  });

  it('does not start a second child when a retry finds the story already submitted', async () => {
    // The double-submit regression: a retry after a later story failed must not
    // re-start a story that already has a row and a run, not even as the `-rN`
    // the allocator hands out once that run has finished.
    const first = await run();
    expect(state.start).toHaveBeenCalledTimes(1);

    const second = await run();

    expect(second.workRequestIds).toEqual(first.workRequestIds);
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it('marks a generated ticket synthetic and a tracker-assigned one as not', async () => {
    // Upstream asserted this flag too; the generated form is namespaced to this
    // submission rather than stamped with a timestamp, so only the shape it relies on
    // (which arm produced the id) is asserted here.
    await runWithTrackerTicket();
    expect(state.runInputCreate.mock.calls[0]?.[0].data).toMatchObject({
      externalTicketId: 'JIRA-1',
      ticketIsSynthetic: false,
    });

    state.runInputCreate.mockClear();
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      workflowId: 'eng-acme-api-PRD-B-1',
    } as never);
    await runFor(PRD_REQUEST_B);
    expect(state.runInputCreate.mock.calls[0]?.[0].data).toMatchObject({ ticketIsSynthetic: true });
  });

  it('keeps the ticket and request id stable on recovery, and separate per submission', async () => {
    await run();
    const firstTicket = childRequest().externalTicketId;
    const firstRequestId = childRequest().workRequestId;

    // Force a recovery attempt and observe it independently: a new ticket or request id here
    // would defeat idempotency, and a shared one across submissions would collide.
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    await run();
    expect(childRequest().externalTicketId).toBe(firstTicket);
    expect(childRequest().workRequestId).toBe(firstRequestId);

    state.start.mockClear();
    // The real allocator would not hand out an id another request has claimed; the mock
    // returns one fixed id, so give the second submission its own.
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      workflowId: 'eng-acme-api-PRD-B-1',
    } as never);
    await runFor(PRD_REQUEST_B);
    expect(childRequest().externalTicketId).not.toBe(firstTicket);
    expect(childRequest().workRequestId).not.toBe(firstRequestId);
  });

  it('does not start a completed child again, even when the allocator offers a rerun id', async () => {
    // The child ran and finished, so the allocator hands out `-rN`. Its WorkflowRun
    // row is what proves the story was already submitted.
    await run();
    state.start.mockClear();
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      workflowId: 'eng-acme-api-PRD-1-r1',
    } as never);

    const result = await run();

    expect(result.workRequestIds).toEqual([prdChildWorkRequestId(PRD_REQUEST, 1)]);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('starts a child whose request was persisted but whose launch was never accepted', async () => {
    // A crash between the commit and the start: request and launch record exist, and
    // nothing was ever accepted under that id, so replaying it is exact.
    await run();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();

    const result = await run();

    expect(state.start).toHaveBeenCalledTimes(1);
    expect(result.workRequestIds).toEqual([prdChildWorkRequestId(PRD_REQUEST, 1)]);
  });

  it('refuses to reuse a persisted child request that describes different work', async () => {
    // A regenerated decomposition at the same position is not the same story.
    await run();
    const id = state.rows.keys().next().value as string;
    state.rows.set(id, { requestPayload: '{"connectionId":"a-different-repo"}' });

    await expect(run()).rejects.toThrow(/describes different work/);
  });

  it('refuses a persisted child whose repository changed but whose story text did not', async () => {
    // Repository identity is part of the submission, not just its text: a changed
    // `repoHint` must not silently reuse the earlier child's repository.
    await run();
    const id = state.rows.keys().next().value as string;
    const stored = state.rows.get(id)?.requestPayload ?? '{}';
    state.rows.set(id, { requestPayload: stored.replace(REPO, 'another-repo-id') });

    await expect(run()).rejects.toThrow(/describes different work/);
  });

  it('reports its own in-flight child without starting a duplicate', async () => {
    // Accepted and still open, but its WorkflowRun row has not landed: there is nothing
    // to do but report it, and no start is even attempted.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    state.runs.clear();
    state.start.mockClear();

    const result = await run();

    expect(state.start).not.toHaveBeenCalled();
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('retires a launch that closed during setup and relaunches under a fresh id', async () => {
    // Retirement, a missing template and an invalid spec all return before the run row
    // is written, so the child closed without materializing. Leaving the record
    // nonterminal would reserve the ticket forever.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    const closedId = state.runs.get(workRequestId)?.workflowId ?? '';
    state.runs.clear();
    state.executions.clear();
    state.closed.add(closedId);
    state.start.mockClear();
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      workflowId: 'eng-acme-api-PRD-1-r1',
    } as never);

    const result = await run();

    expect(vi.mocked(prisma.activeWorkflow.updateMany)).toHaveBeenCalledWith({
      data: { currentStatus: 'FAILED' },
      where: { currentStatus: 'STARTING', temporalWorkflowId: closedId, workRequestId },
    });
    expect(state.start).toHaveBeenCalledWith(
      'RunnableWorkflow',
      expect.objectContaining({ workflowId: 'eng-acme-api-PRD-1-r1' })
    );
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('refuses to launch under an id another request has already claimed', async () => {
    // Allocation saw a free id, but by the time the request is written another
    // submission's launch record owns it. Usage, state and finalization all address the
    // ledger by workflow id, so launching here would corrupt them.
    state.holders.set('eng-acme-api-PRD-1', { workRequestId: 'another-submissions-request' });

    await expect(run()).rejects.toThrow(/already claimed by another work request/);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('fails loudly when a refused start leaves nothing running', async () => {
    // The id is used yet nothing materialized and nothing is still open: the child died
    // during setup under it. Crediting the story here would report work that never began.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    class WorkflowExecutionAlreadyStartedError extends Error {}
    state.start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already used'));

    await expect(run()).rejects.toThrow(/already used and closed without a run/);
    expect(workRequestId).toBe(prdChildWorkRequestId(PRD_REQUEST, 1));
  });

  it('reports the story when a refused start finds the child materialized', async () => {
    // The child materializes between the last check and the start, so the rejection is
    // benign. The reads before the start miss it; the reconciliation read finds it.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    class WorkflowExecutionAlreadyStartedError extends Error {}
    state.start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already used'));
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.workflowRun.findFirst).mockImplementationOnce((async () => ({
      id: 'materialized-at-reconcile',
    })) as never);

    const result = await run();

    expect(state.start).toHaveBeenCalledTimes(1);
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('reports the story when a refused start finds the execution still open', async () => {
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    class WorkflowExecutionAlreadyStartedError extends Error {}
    state.start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already used'));
    // The launch reads as never accepted, so the start is attempted; by the time it is
    // refused the execution is open under that id.
    state.describe.mockImplementationOnce(async () => {
      throw new WorkflowNotFoundError('absent', 'eng-acme-api-PRD-1', undefined);
    });
    state.describe.mockResolvedValueOnce({ status: { name: 'RUNNING' } });

    const result = await run();

    expect(state.start).toHaveBeenCalledTimes(1);
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('keeps the story submitted when the child materializes while the launch is described', async () => {
    // The recheck under the row lock must see it: retiring and relaunching here would run
    // completed work a second time. The first read misses it; the recheck finds it.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    const launchId = state.runs.get(workRequestId)?.workflowId ?? '';
    state.runs.clear();
    state.executions.clear();
    state.closed.add(launchId);
    state.start.mockClear();
    vi.mocked(prisma.activeWorkflow.updateMany).mockClear();
    vi.mocked(prisma.workflowRun.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.workflowRun.findFirst).mockImplementationOnce((async () => {
      state.runs.set(workRequestId, { workflowId: launchId });
      return { id: 'materialized-late' };
    }) as never);

    const result = await run();

    expect(state.start).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.activeWorkflow.updateMany)).not.toHaveBeenCalled();
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('adopts the launch a concurrent attempt recorded instead of its own stale allocation', async () => {
    // This attempt read no request and allocated a free id; by the time it wrote, a
    // winner had recorded its own launch. Starting under the stale allocation would
    // leave the ledger and the running execution disagreeing.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    const payload = state.runInputCreate.mock.calls[0]?.[0].data.requestPayload as string;
    const winnerId = 'eng-acme-api-PRD-1-winner';
    state.rows.clear();
    state.holders.clear();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    state.rows.set(workRequestId, { requestPayload: payload });
    state.holders.set(winnerId, { workRequestId });
    vi.mocked(prisma.runInput.findUnique).mockResolvedValueOnce(null);

    await run();

    expect(state.start.mock.calls[0]?.[1].workflowId).toBe(winnerId);
  });

  it('forbids reusing a workflow id that has already run', async () => {
    // The policy value is the guard, so it is asserted deliberately rather than left to
    // the SDK's default: an id that ran and closed must never host a second execution.
    await run();

    expect(state.start).toHaveBeenCalledWith(
      'RunnableWorkflow',
      expect.objectContaining({ workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE })
    );
  });

  it('keeps the recorded launch id rather than allocating a new one on recovery', async () => {
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    const firstWorkflowId = state.runs.get(workRequestId)?.workflowId;
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      workflowId: 'a-freshly-allocated-id',
    } as never);

    await run();

    expect(state.start.mock.calls[0]?.[1].workflowId).toBe(firstWorkflowId);
  });

  it('fails loudly when a shared tracker ticket is held by a submission that is not this story', async () => {
    // A tracker ticket is shared with other submissions, so a persisted request proves
    // only that this submission accepted the story — not that the holding run is its own.
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      conflictWorkflowId: 'eng-acme-api-JIRA-1',
    } as never);

    await expect(runWithTrackerTicket()).rejects.toThrow(/already held by another run/);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('does not credit a ticket another submission holds, even with this child persisted', async () => {
    // The derived-ticket counterexample: two submissions can derive the same fallback
    // ticket, and a prefix is not a reserved namespace. Without a recorded launch of our
    // own, a holder naming another request must not be credited.
    await run();
    state.runs.clear();
    state.executions.clear();
    state.holders.clear();
    state.start.mockClear();
    state.holders.set('eng-acme-api-PRD-1', { workRequestId: 'a-different-submissions-request' });
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      conflictWorkflowId: 'eng-acme-api-PRD-1',
    } as never);

    await expect(run()).rejects.toThrow(/already held by another run/);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('starts a replacement a concurrent recovery claimed but never launched', async () => {
    // Recovery A retired the predecessor and claimed a replacement, then died before
    // starting it. Recovery B holds a stale read of the predecessor and must not credit the
    // replacement: ownership is not acceptance, so the claim is launched.
    const workRequestId = prdChildWorkRequestId(PRD_REQUEST, 1);
    await run();
    const payload = state.runInputCreate.mock.calls[0]?.[0].data.requestPayload as string;
    const predecessor = 'eng-acme-api-PRD-1';
    const replacement = 'eng-acme-api-PRD-1-r1';
    state.rows.clear();
    state.holders.clear();
    state.runs.clear();
    state.executions.clear();
    state.start.mockClear();
    state.rows.set(workRequestId, { requestPayload: payload });
    state.holders.set(replacement, { workRequestId });
    state.closed.add(predecessor);
    vi.mocked(prisma.activeWorkflow.findFirst).mockResolvedValueOnce({
      temporalWorkflowId: predecessor,
      workRequestId,
    } as never);
    vi.mocked(allocateTicketWorkflowId).mockResolvedValueOnce({
      conflictWorkflowId: replacement,
    } as never);

    const result = await run();

    expect(state.start).toHaveBeenCalledWith(
      'RunnableWorkflow',
      expect.objectContaining({ workflowId: replacement })
    );
    expect(result.workRequestIds).toEqual([workRequestId]);
  });

  it('skips a story whose repository has no template, and starts nothing for it', async () => {
    vi.mocked(resolveTemplateForRepo).mockRejectedValueOnce(
      new NoTemplateForRepoError('no active default workflow template')
    );

    const result = await run();

    expect(result.workRequestIds).toEqual([]);
    expect(state.start).not.toHaveBeenCalled();
  });

  it('fails the activity when the template lookup fails for an operational reason', async () => {
    // A database fault during the lookup is not "this repository has no template".
    vi.mocked(resolveTemplateForRepo).mockRejectedValueOnce(
      new Error('connection terminated unexpectedly')
    );

    await expect(run()).rejects.toThrow('connection terminated unexpectedly');
    expect(state.start).not.toHaveBeenCalled();
  });
});

describe('prdChildWorkRequestId', () => {
  it('is stable per submission and story, and distinct across both', () => {
    const first = prdChildWorkRequestId('prd-a', 1);
    expect(prdChildWorkRequestId('prd-a', 1)).toBe(first);
    expect(prdChildWorkRequestId('prd-a', 2)).not.toBe(first);
    expect(prdChildWorkRequestId('prd-b', 1)).not.toBe(first);
  });

  it('produces a uuid so the id column accepts it', () => {
    // The column only requires a uuid; the version and variant nibbles are an
    // implementation choice, so they are deliberately not pinned here.
    expect(prdChildWorkRequestId('prd-a', 1)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
