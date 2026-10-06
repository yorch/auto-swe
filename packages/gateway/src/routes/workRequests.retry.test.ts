import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workRequestRoutes } from './workRequests.js';

/**
 * `POST /work-requests/:id/retry` answers with the Temporal workflow id it
 * started. The WorkflowRun row is created later by the worker, keyed by that
 * id, so it is the only handle a client has to find the new run.
 */

const OLD = new Date(Date.now() - 60 * 60_000);
const WORK_REQUEST_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

type Ledger = {
  currentStatus: string;
  temporalWorkflowId: string;
  updatedAt: Date;
  workRequestId: string;
};
type LedgerWhere = {
  NOT?: { temporalWorkflowId: { startsWith: string } };
  currentStatus: { notIn: string[] };
  workRequestId: string;
};

describe('POST /work-requests/:id/retry', () => {
  let app: FastifyInstance;
  let started: string[];
  /** The snapshot template row the retry looks up; null = an ordinary template. */
  let snapshotTemplate: { origin: string | null; teamId: string | null } | null;
  /** The launchable row (ACTIVE + visible to the caller); null = archived or off-team. */
  let launchable: { inputSchema: unknown } | null;
  let launchWhere: unknown;
  let payload: Record<string, unknown> | null;
  /** Rows the workflow id allocator reads for the ticket's `eng-…` family. */
  let familyRows: Record<string, unknown>[];
  /** Ledger rows of this request, as the in-flight check reads them. */
  let ledger: Ledger[];
  /** Temporal's answer per workflow id: true = finished or absent, 'throw' = unreachable. */
  let settle: Record<
    string,
    'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'throw' | 'hang' | null
  >;
  let closed: string[];
  let closedStatus: Record<string, string>;

  beforeEach(async () => {
    started = [];
    snapshotTemplate = null;
    launchable = { inputSchema: null };
    launchWhere = undefined;
    payload = { ticket: 'T-1' };
    ledger = [];
    settle = {};
    closed = [];
    closedStatus = {};
    familyRows = [];
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('auth', {
      verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' }),
    } as unknown as never);

    const prismaMock = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      $transaction: async (arg: unknown) => (Array.isArray(arg) ? Promise.all(arg) : undefined),
      activeWorkflow: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'aw-new',
          ...data,
        }),
        delete: async () => ({}),
        findMany: async ({ where }: { where: Partial<LedgerWhere> }) =>
          // The allocator's family read has no `workRequestId`; the in-flight read does.
          where.workRequestId === undefined
            ? familyRows.filter((r) => !closed.includes(r.temporalWorkflowId as string))
            : ledger.filter(
                (r) =>
                  !closed.includes(r.temporalWorkflowId) &&
                  r.workRequestId === where.workRequestId &&
                  !where.currentStatus?.notIn.includes(r.currentStatus) &&
                  !(
                    where.NOT &&
                    r.temporalWorkflowId.startsWith(where.NOT.temporalWorkflowId.startsWith)
                  )
              ),
        findUnique: async ({ where }: { where: { temporalWorkflowId: string } }) => {
          const hit = [...ledger, ...familyRows].find(
            (r) => r.temporalWorkflowId === where.temporalWorkflowId
          );
          return hit ? { updatedAt: hit.updatedAt ?? OLD } : null;
        },
        updateMany: async ({
          data,
          where,
        }: {
          data: { currentStatus: string };
          where: { temporalWorkflowId: { in: string[] } };
        }) => {
          closed.push(...where.temporalWorkflowId.in);
          for (const id of where.temporalWorkflowId.in) {
            closedStatus[id] = data.currentStatus;
          }
          return { count: where.temporalWorkflowId.in.length };
        },
      },
      connection: { findUnique: async () => null },
      organizationMembership: { findUnique: async () => ({ role: 'ORG_MEMBER' }) },
      orgMonthlyUsage: { findUnique: async () => null },
      runInput: {
        findUnique: async () => ({
          activeWorkflows: [
            {
              assignedBranch: 'auto/T-1',
              budgetTier: 'STANDARD',
              repository: {
                githubUrl: null,
                id: 'repo-1',
                installation: null,
                isActive: true,
                organizationName: 'org',
                repoName: 'test',
                shares: [],
                team: {
                  memberships: [{ userId: 'user-1' }],
                  organization: { id: 'org-1', monthlyBudgetUsdCents: null },
                  orgId: 'org-1',
                },
                teamId: 'team-1',
                type: 'git_repo',
              },
            },
          ],
          description: 'do it',
          externalTicketId: 'T-1',
          id: WORK_REQUEST_ID,
          payload,
          requestPayload: null,
          templateId: 'tpl-1',
          templateVersion: 2,
        }),
      },
      workflowTemplate: {
        findFirst: async ({ where }: { where: { status?: string } }) => {
          if (where.status) {
            launchWhere = where;
            return launchable;
          }
          return snapshotTemplate;
        },
      },
    };
    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      startRunnableWorkflow: async (workflowId: string) => {
        started.push(workflowId);
      },
      workflowSettledStatus: async (workflowId: string) => {
        const answer = settle[workflowId] ?? null;
        if (answer === 'throw') {
          throw new Error('temporal unreachable');
        }
        if (answer === 'hang') {
          return new Promise<never>(() => undefined);
        }
        return answer;
      },
    } as unknown as never);
    app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterEach(() => app.close());

  it('returns the Temporal workflow id it started alongside the ledger id', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });

    expect(res.statusCode).toBe(201);
    expect(started).toHaveLength(1);
    const { data } = res.json();
    expect(data.temporalWorkflowId).toBe(started[0]);
    expect(data.workRequestId).toBe(WORK_REQUEST_ID);
    expect(data.workflowIds).toEqual(['aw-new']);
  });

  it('refuses to retry an agent run (its payload is dropped and its branch would collide)', async () => {
    snapshotTemplate = { origin: 'system:agent-run', teamId: null };
    const res = await app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('USE_AGENT_RUN_RERUN');
    expect(started).toHaveLength(0);
  });

  const retry = () =>
    app.inject({
      headers: { authorization: 'Bearer t' },
      method: 'POST',
      payload: {},
      url: `/api/v1/work-requests/${WORK_REQUEST_ID}/retry`,
    });

  it('refuses a git-backed retry of a template that is archived or off the caller’s team', async () => {
    launchable = null;
    const res = await retry();
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TEMPLATE_NOT_FOUND');
    expect(launchWhere).toMatchObject({ id: 'tpl-1', status: 'ACTIVE' });
    expect(started).toHaveLength(0);
  });

  it('refuses a git-backed retry whose recorded inputs fail the input schema', async () => {
    launchable = {
      inputSchema: { properties: { ticket: { type: 'number' } }, type: 'object' },
    };
    const res = await retry();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(started).toHaveLength(0);
  });

  it('launches a git-backed retry whose inputs satisfy the schema', async () => {
    launchable = {
      inputSchema: { properties: { ticket: { type: 'string' } }, type: 'object' },
    };
    expect((await retry()).statusCode).toBe(201);
    expect(started).toHaveLength(1);
  });

  it('skips the schema check for a request with no recorded payload', async () => {
    payload = null;
    launchable = { inputSchema: { properties: {}, required: ['x'], type: 'object' } };
    expect((await retry()).statusCode).toBe(201);
  });

  const row = (temporalWorkflowId: string, currentStatus: string, updatedAt = OLD): Ledger => ({
    currentStatus,
    temporalWorkflowId,
    updatedAt,
    workRequestId: WORK_REQUEST_ID,
  });
  const FIRE = 'sched-aaaa-2026-10-06T09:00:00Z';

  it('refuses a retry of a scheduled request while one of its fires is running', async () => {
    ledger = [row(FIRE, 'IMPLEMENTING')];
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WORKFLOW_ALREADY_EXISTS');
    expect(res.json().error.message).toContain(FIRE);
    expect(started).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('refuses a retry of a template-launched request while its wf- run is in flight', async () => {
    ledger = [row('wf-tpl-1a2b3c4d', 'IMPLEMENTING')];
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('wf-tpl-1a2b3c4d');
    expect(started).toHaveLength(0);
  });

  it('allows a retry once the fires are finished, whatever the anchor row says', async () => {
    ledger = [
      row(FIRE, 'COMPLETED'),
      row('sched-aaaa-2026-10-06T10:00:00Z', 'FAILED'),
      // The schedule's standing anchor is not an execution.
      row('sched-aaaa', 'SCHEDULED'),
    ];
    expect((await retry()).statusCode).toBe(201);
    expect(started).toHaveLength(1);
  });

  it('closes a stale ledger row whose workflow Temporal reports finished, and proceeds', async () => {
    ledger = [row(FIRE, 'STARTING')];
    settle[FIRE] = 'CANCELLED';
    expect((await retry()).statusCode).toBe(201);
    expect(closed).toEqual([FIRE]);
    expect(closedStatus[FIRE]).toBe('CANCELLED');
    expect(started).toHaveLength(1);
  });

  it('trusts a row written moments ago without asking Temporal', async () => {
    ledger = [row(FIRE, 'STARTING', new Date())];
    settle[FIRE] = 'CANCELLED';
    expect((await retry()).statusCode).toBe(409);
    expect(closed).toEqual([]);
  });

  it('refuses, saying why, when Temporal cannot be asked', async () => {
    ledger = [row(FIRE, 'IMPLEMENTING')];
    settle[FIRE] = 'throw';
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Temporal unreachable');
    expect(closed).toEqual([]);
    expect(started).toHaveLength(0);
  });

  const ENG = 'eng-org-test-T-1';
  const engRow = (workRequestId: string | null, updatedAt = OLD) => ({
    currentStatus: 'IMPLEMENTING',
    repoId: 'repo-1',
    temporalWorkflowId: ENG,
    updatedAt,
    workRequest: { externalTicketId: 'T-1' },
    workRequestId,
  });

  it('still refuses with the eng-family conflict when a run of the ticket is in flight', async () => {
    familyRows = [engRow(null)];
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WORKFLOW_ALREADY_EXISTS');
    expect(res.json().error.message).toContain(ENG);
    expect(started).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('closes a previous eng- run of this request whose workflow is gone, and retries', async () => {
    familyRows = [engRow(WORK_REQUEST_ID)];
    ledger = [row(ENG, 'IMPLEMENTING')];
    settle[ENG] = 'FAILED';
    const res = await retry();
    expect(res.statusCode).toBe(201);
    expect(closedStatus[ENG]).toBe('FAILED');
    expect(started).toHaveLength(1);
  });

  it('closes a gone eng- row of another request in the ticket family, and retries', async () => {
    familyRows = [engRow('another-request')];
    settle[ENG] = 'FAILED';
    const res = await retry();
    expect(res.statusCode).toBe(201);
    expect(closed).toEqual([ENG]);
  });

  it('keeps refusing on a live eng- row of another request, and says so when unconfirmable', async () => {
    familyRows = [engRow('another-request')];
    expect((await retry()).statusCode).toBe(409);
    settle[ENG] = 'throw';
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Temporal unreachable');
    expect(started).toHaveLength(0);
    expect(closed).toEqual([]);
  });

  it('does not name the workflow of another connection row when it cannot be confirmed', async () => {
    familyRows = [{ ...engRow('another-request'), repoId: null }];
    settle[ENG] = 'throw';
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Temporal unreachable');
    expect(res.json().error.message).not.toContain(ENG);
  });

  it('blocks, unconfirmed, when the Temporal lookup never answers', async () => {
    vi.useFakeTimers();
    try {
      ledger = [row(FIRE, 'IMPLEMENTING')];
      settle[FIRE] = 'hang';
      const pending = retry();
      await vi.advanceTimersByTimeAsync(3_100);
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toContain('Temporal unreachable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at the live row of several, closing the finished one before it', async () => {
    ledger = [
      { ...row('sched-aaaa-1', 'IMPLEMENTING'), updatedAt: new Date(OLD.getTime() - 2000) },
      { ...row('sched-aaaa-2', 'IMPLEMENTING'), updatedAt: new Date(OLD.getTime() - 1000) },
      { ...row('sched-aaaa-3', 'IMPLEMENTING') },
    ];
    settle['sched-aaaa-1'] = 'COMPLETED';
    const res = await retry();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('sched-aaaa-2');
    expect(closed).toEqual(['sched-aaaa-1']);
    expect(closedStatus['sched-aaaa-1']).toBe('COMPLETED');
  });
});
