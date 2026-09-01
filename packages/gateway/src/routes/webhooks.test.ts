import crypto from 'node:crypto';
import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable per-test view of the DB-backed configs.
// resolveGitHubConfig is called by the HMAC verifier (webhookSecret) and by
// the /ci check-run aggregation (apiUrl + token).
// resolveIssueTrackerConfig is called by the /jira route for sig + trigger checks,
// and by /git + /ci for best-effort tracker sync.
const state = vi.hoisted(() => ({
  github: {
    apiUrl: 'https://api.github.com',
    token: 'gh-pat-token' as string | null,
    webhookSecret: 'hook-secret' as string | null,
  },
  jira: {
    provider: 'jira' as string | null,
    webhookSecret: null as string | null,
    webhookTriggerStatus: 'Ready for Dev' as string | null,
  },
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => state.github),
  resolveIssueTrackerConfig: vi.fn(async () => state.jira),
  resolveSlackBotTokenForSlackChannel: vi.fn(async () => null),
}));

vi.mock('@auto-swe/shared/lib/trackerSync', () => ({
  syncTrackerOnEvent: vi.fn(async () => {}),
}));

// Module-level prisma used directly by the /jira route handler.
// Mutable per-test via jiraPrismaState.
const jiraPrismaState = vi.hoisted(() => ({
  activeRepo: null as Record<string, unknown> | null,
  activeWorkflowCreateCalls: [] as Record<string, unknown>[],
  activeWorkflowDeleteCalls: 0,
  defaultTemplate: { activeVersion: 1, id: 'tpl-1' } as Record<string, unknown> | null,
  /**
   * Stands in for the `active_workflows` table: row id → temporalWorkflowId.
   * Enough to enforce the real `@unique` on `temporal_workflow_id`, so the
   * tests exercise genuine insert-then-conflict rather than a mocked branch.
   */
  rows: new Map<string, string>(),
  runInputCreateCalls: [] as Record<string, unknown>[],
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    // The launch path writes its ledger rows in one transaction; the array
    // form just resolves the queued promises in order.
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    activeWorkflow: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        // Enforce the real unique index on `temporal_workflow_id` — the
        // primary dedup gate for the auto-trigger.
        const wfId = args.data.temporalWorkflowId as string;
        if ([...jiraPrismaState.rows.values()].includes(wfId)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const id = `aw-${jiraPrismaState.rows.size + 1}`;
        jiraPrismaState.rows.set(id, wfId);
        jiraPrismaState.activeWorkflowCreateCalls.push(args.data);
        return { id, ...args.data };
      }),
      // Compensation frees the ID again, so a rolled-back launch doesn't
      // permanently block the ticket.
      delete: vi.fn(async (args: { where: { id: string } }) => {
        jiraPrismaState.activeWorkflowDeleteCalls += 1;
        jiraPrismaState.rows.delete(args.where.id);
        return {};
      }),
    },
    connection: {
      findFirst: vi.fn(async () => jiraPrismaState.activeRepo),
    },
    runInput: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        jiraPrismaState.runInputCreateCalls.push(args.data);
        return { id: 'ri-1', ...args.data };
      }),
      delete: vi.fn(async () => ({})),
    },
    workflowTemplate: {
      findFirst: vi.fn(async () => jiraPrismaState.defaultTemplate),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { webhookRoutes } from './webhooks.js';

const SECRET = 'hook-secret';

function sign(payload: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

interface SignalCall {
  workflowId: string;
  signalName: string;
  args: unknown[];
}

interface UpdateCall {
  data: Record<string, unknown>;
  where: Record<string, unknown>;
}

describe('webhook routes', () => {
  const app = Fastify();

  // Mutable per-test DB state
  let trackedPr: Record<string, unknown> | null = null;
  let openPrs: Array<Record<string, unknown>> = [];
  const updateCalls: UpdateCall[] = [];
  const updateManyCalls: UpdateCall[] = [];
  // Per-call override for updateMany's returned `count` (index-aligned with
  // updateManyCalls) — used to simulate the "already at this ciStatus" no-op
  // path for the duplicate-delivery idempotency test. `null` means every call
  // transitions (count: 1), matching a first-time delivery.
  let updateManyResultCounts: number[] | null = null;
  /**
   * Stands in for `pull_requests.status` on the single row the /git tests use.
   * The handler's OPEN→MERGED `updateMany` is a *guarded* write, so the mock
   * has to model the guard for the duplicate/rollback tests to mean anything.
   */
  let prRowStatus = 'OPEN';
  /**
   * Stands in for `pull_requests.ci_status`, keyed by row id. The /ci handler's
   * write is guarded on `ciStatus` AND `headSha`, so the mock models both —
   * otherwise the stale-redelivery test would be asserting against a mock that
   * always transitions. Falls back to the fixture row's `ciStatus` until the
   * first successful write.
   */
  const prCiStatus = new Map<string, string>();
  const signalCalls: SignalCall[] = [];
  /** Workflow IDs whose signal should reject, simulating a Temporal outage. */
  const signalFailWorkflowIds = new Set<string>();
  /**
   * Workflow IDs whose signal should reject with `WorkflowNotFoundError` — the
   * terminal case: the execution completed, was terminated, or never started.
   * No redelivery can ever land that signal.
   */
  const signalGoneWorkflowIds = new Set<string>();
  const evalCreateCalls: Array<Record<string, unknown>> = [];
  let workflowRunRow: { id: string } | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let jiraStartShouldConflict = false;
  /** When set, the next workflow start rejects with this error (transient outage). */
  let jiraStartFailure: Error | null = null;
  const jiraStartCalls: Array<{ id: string; args: unknown }> = [];

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifyRawBody, { encoding: 'utf8', global: false, runFirst: true });

    app.decorate('prisma', {
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
      evalResult: {
        create: async (args: { data: Record<string, unknown> }) => {
          evalCreateCalls.push(args.data);
          return { id: 'eval-1' };
        },
      },
      pullRequest: {
        findFirst: async () => trackedPr,
        // The real query filters on the event's head SHA and returns the row's
        // current ci_status; fixtures without a `headSha` match any SHA.
        findMany: async (args: { where: { headSha?: string } }) =>
          openPrs
            .filter((pr) => pr.headSha === undefined || pr.headSha === args.where.headSha)
            .map((pr) => ({
              ...pr,
              ciStatus: prCiStatus.get(pr.id as string) ?? pr.ciStatus,
            })),
        update: async (args: UpdateCall) => {
          updateCalls.push(args);
          return { id: args.where.id };
        },
        updateMany: async (args: UpdateCall) => {
          const idx = updateManyCalls.length;
          updateManyCalls.push(args);
          // /git writes `status`; model the OPEN→MERGED guard for real so the
          // duplicate and rollback paths are genuinely exercised.
          if (typeof args.data.status === 'string') {
            const guard = args.where.status as string | undefined;
            if (guard !== undefined && guard !== prRowStatus) {
              return { count: 0 };
            }
            prRowStatus = args.data.status;
            return { count: 1 };
          }
          // /ci writes `ciStatus`. An explicit updateManyResultCounts still
          // forces the count (used to stage races the row state can't express);
          // otherwise the ciStatus + headSha guard is evaluated for real.
          if (updateManyResultCounts) {
            return { count: updateManyResultCounts[idx] ?? 1 };
          }
          const id = args.where.id as string;
          const row = openPrs.find((pr) => pr.id === id);
          const current = prCiStatus.get(id) ?? (row?.ciStatus as string | undefined) ?? 'PENDING';
          const statusGuard = args.where.ciStatus as string | undefined;
          if (statusGuard !== undefined && statusGuard !== current) {
            return { count: 0 };
          }
          const shaGuard = args.where.headSha as string | undefined;
          const rowSha = row?.headSha as string | undefined;
          if (shaGuard !== undefined && rowSha !== undefined && rowSha !== shaGuard) {
            return { count: 0 };
          }
          prCiStatus.set(id, args.data.ciStatus as string);
          return { count: 1 };
        },
      },
      workflowRun: {
        findFirst: async () => workflowRunRow,
      },
    } as unknown as never);

    Object.assign(app.prisma, prisma);

    app.decorate('temporal', {
      signalWorkflow: async (workflowId: string, signalName: string, args: unknown[]) => {
        // Record the attempt either way — the failure tests assert on retries.
        signalCalls.push({ args, signalName, workflowId });
        if (signalGoneWorkflowIds.has(workflowId)) {
          const err = new Error(`workflow execution not found: ${workflowId}`);
          err.name = 'WorkflowNotFoundError';
          throw err;
        }
        if (signalFailWorkflowIds.has(workflowId)) {
          throw new Error(`temporal unreachable for ${workflowId}`);
        }
      },
      startRunnableWorkflow: async (id: string, args: unknown) => {
        if (jiraStartFailure) {
          throw jiraStartFailure;
        }
        if (jiraStartShouldConflict) {
          const err = new Error('already started');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }
        jiraStartCalls.push({ args, id });
      },
    } as unknown as never);

    await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    trackedPr = null;
    openPrs = [];
    updateCalls.length = 0;
    updateManyCalls.length = 0;
    updateManyResultCounts = null;
    prRowStatus = 'OPEN';
    prCiStatus.clear();
    signalCalls.length = 0;
    signalFailWorkflowIds.clear();
    signalGoneWorkflowIds.clear();
    evalCreateCalls.length = 0;
    workflowRunRow = null;
    state.github = {
      apiUrl: 'https://api.github.com',
      token: 'gh-pat-token',
      webhookSecret: SECRET,
    };
    state.jira = {
      provider: 'jira',
      webhookSecret: null,
      webhookTriggerStatus: 'Ready for Dev',
    };
    jiraPrismaState.activeRepo = null;
    jiraPrismaState.runInputCreateCalls.length = 0;
    jiraPrismaState.activeWorkflowCreateCalls.length = 0;
    jiraPrismaState.activeWorkflowDeleteCalls = 0;
    jiraPrismaState.defaultTemplate = { activeVersion: 1, id: 'tpl-1' };
    jiraStartShouldConflict = false;
    jiraStartFailure = null;
    jiraPrismaState.rows.clear();
    jiraStartCalls.length = 0;
    fetchMock = vi.fn(async () => {
      throw new Error('fetch not stubbed for this test');
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function inject(url: string, body: string, signature?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) {
      headers['x-hub-signature-256'] = signature;
    }
    return app.inject({ headers, method: 'POST', payload: body, url });
  }

  // ── POST /api/v1/webhooks/git ──

  describe('POST /git', () => {
    const mergedPayload = JSON.stringify({
      action: 'closed',
      pull_request: { merged: true, number: 42 },
      repository: { full_name: 'acme/payments-api' },
    });

    function trackedRow(): Record<string, unknown> {
      return {
        id: 'pr-row-1',
        workflow: {
          repository: { team: null },
          temporalWorkflowId: 'eng-acme-payments-api-JIRA-1',
          workRequest: null,
        },
      };
    }

    it('returns 401 when the signature header is missing', async () => {
      const res = await inject('/api/v1/webhooks/git', mergedPayload);
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).error.code).toBe('WEBHOOK_AUTH_FAILED');
    });

    it('returns 401 when the signature is invalid', async () => {
      const res = await inject(
        '/api/v1/webhooks/git',
        mergedPayload,
        sign(mergedPayload, 'wrong-secret')
      );
      expect(res.statusCode).toBe(401);
      expect(signalCalls).toHaveLength(0);
    });

    it('ignores a validly-signed payload with an unrecognized shape', async () => {
      const body = JSON.stringify({ action: 'closed', zen: 'Design for failure.' });
      const res = await inject('/api/v1/webhooks/git', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        ignored: true,
        reason: 'Unrecognized payload shape',
      });
      expect(signalCalls).toHaveLength(0);
    });

    it('marks the PR MERGED and signals humanMergeSignal on a merged close', async () => {
      trackedPr = trackedRow();
      workflowRunRow = { id: 'run-1' };
      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        signalSent: true,
        workflowId: 'eng-acme-payments-api-JIRA-1',
      });
      expect(updateManyCalls).toEqual([
        { data: { status: 'MERGED' }, where: { id: 'pr-row-1', status: 'OPEN' } },
      ]);
      expect(prRowStatus).toBe('MERGED');
      expect(signalCalls).toEqual([
        {
          args: [true],
          signalName: 'humanMergeSignal',
          workflowId: 'eng-acme-payments-api-JIRA-1',
        },
      ]);
      // P0 evals: captured the human merge label, linked to the resolved run.
      expect(evalCreateCalls).toEqual([
        {
          metadata: { prNumber: 42 },
          passed: true,
          runId: 'run-1',
          scorer: 'merge',
          scoreType: 'BOOLEAN',
          source: 'MERGE',
          value: 1,
        },
      ]);
    });

    it('still merges + signals when eval capture finds no linked run', async () => {
      trackedPr = trackedRow();
      workflowRunRow = null; // no WorkflowRun row resolves
      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));
      expect(res.statusCode).toBe(200);
      expect(signalCalls).toHaveLength(1);
      expect(evalCreateCalls).toHaveLength(0);
    });

    it('ignores a non-merged close', async () => {
      trackedPr = trackedRow();
      const body = JSON.stringify({
        action: 'closed',
        pull_request: { merged: false, number: 42 },
        repository: { full_name: 'acme/payments-api' },
      });
      const res = await inject('/api/v1/webhooks/git', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({ ignored: true });
      expect(updateCalls).toHaveLength(0);
      expect(updateManyCalls).toHaveLength(0);
      expect(signalCalls).toHaveLength(0);
    });

    it('ignores merged PRs with no tracked workflow', async () => {
      trackedPr = null;
      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        ignored: true,
        reason: 'No tracked workflow for this PR',
      });
      expect(signalCalls).toHaveLength(0);
    });

    it('no-ops without re-signaling when the row is already MERGED (duplicate delivery)', async () => {
      // The lookup raced another delivery and handed back a stale OPEN row;
      // the guarded update is what actually decides, and it updates 0 rows.
      trackedPr = trackedRow();
      prRowStatus = 'MERGED';
      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        ignored: true,
        reason: 'PR already merged (duplicate delivery)',
      });
      expect(signalCalls).toHaveLength(0);
      expect(evalCreateCalls).toHaveLength(0);
    });

    it('rolls the PR back to OPEN and answers 503 when the merge signal fails', async () => {
      // The bug this guards: committing status=MERGED before the durable
      // signal made GitHub's redelivery find no OPEN PR, so the merge signal
      // was lost forever and the workflow hung until timeout.
      trackedPr = trackedRow();
      workflowRunRow = { id: 'run-1' };
      signalFailWorkflowIds.add('eng-acme-payments-api-JIRA-1');

      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload).error.code).toBe('SIGNAL_FAILED');
      // Marked MERGED, then reverted — the row is recoverable.
      expect(updateManyCalls).toEqual([
        { data: { status: 'MERGED' }, where: { id: 'pr-row-1', status: 'OPEN' } },
        { data: { status: 'OPEN' }, where: { id: 'pr-row-1', status: 'MERGED' } },
      ]);
      expect(prRowStatus).toBe('OPEN');
      // Downstream side effects must not run on the failed path.
      expect(evalCreateCalls).toHaveLength(0);
    });

    it('keeps the PR MERGED and answers 200 when the target workflow is gone', async () => {
      // Terminal signal failure: the execution completed, was terminated, or
      // never started. Rolling back would record OPEN for a PR that IS merged
      // on GitHub, and every redelivery would repeat the cycle forever without
      // ever being able to succeed — there is no run left to strand, so the
      // merge is recorded and the delivery is accepted.
      trackedPr = trackedRow();
      workflowRunRow = { id: 'run-1' };
      signalGoneWorkflowIds.add('eng-acme-payments-api-JIRA-1');

      const res = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        reason: 'Workflow no longer running; merge recorded only',
        signalSent: false,
        workflowId: 'eng-acme-payments-api-JIRA-1',
      });
      // Marked MERGED and left there — no rollback write at all.
      expect(updateManyCalls).toEqual([
        { data: { status: 'MERGED' }, where: { id: 'pr-row-1', status: 'OPEN' } },
      ]);
      expect(prRowStatus).toBe('MERGED');
      // The merge really happened, so the merge-label capture still runs.
      expect(evalCreateCalls).toHaveLength(1);
    });

    it('re-signals on a manual redelivery after a failed merge signal', async () => {
      trackedPr = trackedRow();
      signalFailWorkflowIds.add('eng-acme-payments-api-JIRA-1');
      const failed = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));
      expect(failed.statusCode).toBe(503);
      expect(prRowStatus).toBe('OPEN');

      // Temporal recovers; the same event is delivered again (GitHub does not
      // retry a failed delivery on its own — an operator presses "Redeliver").
      signalFailWorkflowIds.clear();
      signalCalls.length = 0;
      updateManyCalls.length = 0;
      const retried = await inject('/api/v1/webhooks/git', mergedPayload, sign(mergedPayload));

      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.payload).data).toEqual({
        signalSent: true,
        workflowId: 'eng-acme-payments-api-JIRA-1',
      });
      expect(signalCalls).toEqual([
        {
          args: [true],
          signalName: 'humanMergeSignal',
          workflowId: 'eng-acme-payments-api-JIRA-1',
        },
      ]);
      expect(prRowStatus).toBe('MERGED');
    });
  });

  // ── POST /api/v1/webhooks/ci ──

  describe('POST /ci', () => {
    const HEAD_SHA = 'abc123def456';

    function ciPayload(conclusion: string): string {
      return JSON.stringify({
        action: 'completed',
        check_run: {
          conclusion,
          head_sha: HEAD_SHA,
          html_url: 'https://github.com/acme/payments-api/runs/1',
        },
        repository: { full_name: 'acme/payments-api' },
      });
    }

    function checkRunsResponse(
      runs: Array<{ status: string; conclusion: string | null; html_url: string }>,
      totalCount?: number
    ) {
      return {
        json: async () => ({ check_runs: runs, total_count: totalCount ?? runs.length }),
        ok: true,
      };
    }

    beforeEach(() => {
      openPrs = [
        {
          ciStatus: 'PENDING',
          headSha: HEAD_SHA,
          id: 'pr-row-1',
          workflow: { temporalWorkflowId: 'wf-ci-1' },
        },
      ];
    });

    it('signals ciPipelineSignal immediately on a failing conclusion (no aggregation fetch)', async () => {
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'failure',
        signaled: ['wf-ci-1'],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'FAILED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('is idempotent: a redelivered webhook whose ciStatus is unchanged signals nothing', async () => {
      // count: 0 simulates the PR already sitting at ciStatus=FAILED.
      updateManyResultCounts = [0];
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'failure',
        ignored: true,
        reason: 'CI verdict already recorded for this commit',
      });
      expect(signalCalls).toHaveLength(0);
    });

    it('defers (no signal) when a successful run has siblings still in progress', async () => {
      fetchMock.mockResolvedValueOnce(
        checkRunsResponse([
          { conclusion: 'success', html_url: 'https://x/runs/1', status: 'completed' },
          { conclusion: null, html_url: 'https://x/runs/2', status: 'in_progress' },
        ])
      );
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'success',
        deferred: true,
        reason: 'Other check runs still in progress',
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.github.com/repos/acme/payments-api/commits/${HEAD_SHA}/check-runs?per_page=100&page=1`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer gh-pat-token' }),
        })
      );
      expect(signalCalls).toHaveLength(0);
      expect(updateCalls).toHaveLength(0);
    });

    it('signals passed=true once every check run has completed successfully', async () => {
      fetchMock.mockResolvedValueOnce(
        checkRunsResponse([
          { conclusion: 'success', html_url: 'https://x/runs/1', status: 'completed' },
          { conclusion: 'skipped', html_url: 'https://x/runs/2', status: 'completed' },
          { conclusion: 'neutral', html_url: 'https://x/runs/3', status: 'completed' },
        ])
      );
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'success',
        signaled: ['wf-ci-1'],
      });
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'PASSED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('signals passed=false with the failing run html_url when a sibling failed', async () => {
      fetchMock.mockResolvedValueOnce(
        checkRunsResponse([
          { conclusion: 'success', html_url: 'https://x/runs/1', status: 'completed' },
          { conclusion: 'failure', html_url: 'https://x/runs/2-failed', status: 'completed' },
        ])
      );
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'FAILED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://x/runs/2-failed', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('falls back to per-run signaling when the aggregation fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('GitHub API down'));
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'success',
        signaled: ['wf-ci-1'],
      });
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('falls back to per-run signaling when no PAT is configured (token null)', async () => {
      state.github = { ...state.github, token: null };
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('paginates the check-runs listing across multiple pages when total_count exceeds one page', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        conclusion: 'success',
        html_url: `https://x/runs/${i}`,
        status: 'completed',
      }));
      const page2 = [
        { conclusion: 'success', html_url: 'https://x/runs/100', status: 'completed' },
        { conclusion: 'failure', html_url: 'https://x/runs/101-failed', status: 'completed' },
      ];
      fetchMock
        .mockResolvedValueOnce(checkRunsResponse(page1, 102))
        .mockResolvedValueOnce(checkRunsResponse(page2, 102));
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('per_page=100&page=1'),
        expect.anything()
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('per_page=100&page=2'),
        expect.anything()
      );
      // The second page's failing run decides the aggregated outcome.
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'FAILED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://x/runs/101-failed', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('falls back to per-run signaling when the run count is truncated past the page cap', async () => {
      // total_count of 1000 can never be reached within 5 pages of 100, so
      // aggregation gives up and the handler falls back to legacy signaling.
      const fullPage = Array.from({ length: 100 }, (_, i) => ({
        conclusion: 'success',
        html_url: `https://x/runs/${i}`,
        status: 'completed',
      }));
      fetchMock.mockResolvedValue(checkRunsResponse(fullPage, 1000));
      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(JSON.parse(res.payload).data).toEqual({
        conclusion: 'success',
        signaled: ['wf-ci-1'],
      });
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('keeps paginating when total_count is absent and the page is full', async () => {
      // Regression: the page count was previously used as the total when
      // `total_count` was missing, so a FULL first page satisfied
      // `runs.length >= totalCount` and aggregation concluded "complete" from
      // page 1 alone — defeating the truncation guard and hiding page 2's
      // failure. Without `total_count` a full page must NOT end the walk; only
      // a short page (or the page cap) does.
      const noTotal = (
        runs: Array<{ status: string; conclusion: string | null; html_url: string }>
      ) => ({
        json: async () => ({ check_runs: runs }),
        ok: true,
      });
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        conclusion: 'success',
        html_url: `https://x/runs/${i}`,
        status: 'completed',
      }));
      const page2 = [
        { conclusion: 'failure', html_url: 'https://x/runs/100-failed', status: 'completed' },
      ];
      fetchMock.mockResolvedValueOnce(noTotal(page1)).mockResolvedValueOnce(noTotal(page2));

      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Page 2's failing run must decide the outcome.
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://x/runs/100-failed', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('stops on a short page when total_count is absent', async () => {
      const page1 = [{ conclusion: 'success', html_url: 'https://x/runs/0', status: 'completed' }];
      fetchMock.mockResolvedValueOnce({
        json: async () => ({ check_runs: page1 }),
        ok: true,
      });

      const body = ciPayload('success');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('rolls ciStatus back and answers 503 when the CI signal fails', async () => {
      // The bug this guards: a rejected signal was only logged and the handler
      // still returned 200, so GitHub never redelivered — and because ciStatus
      // had already flipped, the idempotency guard made any later delivery a
      // no-op. The CI-fix loop then never fired.
      signalFailWorkflowIds.add('wf-ci-1');
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload).error.code).toBe('SIGNAL_FAILED');
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'FAILED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
        // Reverted to the value the row held before this delivery, guarded on
        // the status this delivery wrote.
        {
          data: { ciStatus: 'PENDING' },
          where: { ciStatus: 'FAILED', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
    });

    it('re-signals on redelivery after a failed CI signal', async () => {
      signalFailWorkflowIds.add('wf-ci-1');
      const body = ciPayload('failure');
      const failed = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(failed.statusCode).toBe(503);

      // Rolled back to PENDING, so the redelivery's freshness guard
      // (`ciStatus: PENDING` at this head SHA) transitions the row again and
      // the signal is retried.
      signalFailWorkflowIds.clear();
      signalCalls.length = 0;
      updateManyCalls.length = 0;
      const retried = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.payload).data).toEqual({
        conclusion: 'failure',
        signaled: ['wf-ci-1'],
      });
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
    });

    it('does not replay a stale rolled-back verdict over a newer one', async () => {
      // 1. Delivery A (failure) transitions PENDING→FAILED; its signal fails,
      //    so the row rolls back to PENDING and the delivery is marked failed.
      signalFailWorkflowIds.add('wf-ci-1');
      const failBody = ciPayload('failure');
      const first = await inject('/api/v1/webhooks/ci', failBody, sign(failBody));
      expect(first.statusCode).toBe(503);
      expect(prCiStatus.get('pr-row-1')).toBe('PENDING');

      // 2. CI re-runs on the same commit. Delivery B (success) transitions
      //    PENDING→PASSED and signals cleanly; the run resumes on passed:true.
      signalFailWorkflowIds.clear();
      signalCalls.length = 0;
      fetchMock.mockResolvedValueOnce(
        checkRunsResponse([
          { conclusion: 'success', html_url: 'https://x/runs/1', status: 'completed' },
        ])
      );
      const passBody = ciPayload('success');
      const second = await inject('/api/v1/webhooks/ci', passBody, sign(passBody));
      expect(second.statusCode).toBe(200);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: true }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
      expect(prCiStatus.get('pr-row-1')).toBe('PASSED');

      // 3. An operator presses "Redeliver" on A — exactly what the 503 in step
      //    1 invites. A change-detecting guard (`ciStatus: { not: FAILED }`)
      //    would flip PASSED→FAILED and re-signal passed:false with a stale
      //    logs URL into a run that has already moved on. The freshness guard
      //    drops it: the verdict for this head was already delivered.
      signalCalls.length = 0;
      updateManyCalls.length = 0;
      const replay = await inject('/api/v1/webhooks/ci', failBody, sign(failBody));

      expect(replay.statusCode).toBe(200);
      expect(JSON.parse(replay.payload).data).toEqual({
        conclusion: 'failure',
        ignored: true,
        reason: 'CI verdict already recorded for this commit',
      });
      expect(signalCalls).toHaveLength(0);
      expect(prCiStatus.get('pr-row-1')).toBe('PASSED');
    });

    it('keeps the recorded ciStatus and answers 200 when the target workflow is gone', async () => {
      // Terminal failure: no redelivery can ever land the signal, so rolling
      // back and answering 503 would only invite a loop that rewrites ciStatus
      // for a run that no longer exists.
      signalGoneWorkflowIds.add('wf-ci-1');
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({ conclusion: 'failure', signaled: [] });
      // Transitioned once, never reverted.
      expect(updateManyCalls).toEqual([
        {
          data: { ciStatus: 'FAILED' },
          where: { ciStatus: 'PENDING', headSha: HEAD_SHA, id: 'pr-row-1' },
        },
      ]);
      expect(prCiStatus.get('pr-row-1')).toBe('FAILED');
    });

    it('signals a fresh verdict after the worker pushes a new head', async () => {
      // The freshness token is (ciStatus PENDING, headSha). A new head re-arms
      // ciStatus to PENDING in `createOrUpdatePullRequest`, so the next CI wait
      // is signaled even though the row already carries a terminal verdict from
      // the previous head.
      const NEXT_SHA = 'def789abc012';
      openPrs = [
        {
          ciStatus: 'FAILED',
          headSha: HEAD_SHA,
          id: 'pr-row-1',
          workflow: { temporalWorkflowId: 'wf-ci-1' },
        },
      ];
      // A check-run event for the superseded head no longer matches the row.
      const staleBody = JSON.stringify({
        action: 'completed',
        check_run: {
          conclusion: 'failure',
          head_sha: 'older000sha',
          html_url: 'https://github.com/acme/payments-api/runs/0',
        },
        repository: { full_name: 'acme/payments-api' },
      });
      const stale = await inject('/api/v1/webhooks/ci', staleBody, sign(staleBody));
      expect(JSON.parse(stale.payload).data).toEqual({
        ignored: true,
        reason: 'No tracked PR for this commit',
      });
      expect(signalCalls).toHaveLength(0);

      // The worker pushes the fix, so the row is now (NEXT_SHA, PENDING).
      openPrs = [
        {
          ciStatus: 'PENDING',
          headSha: NEXT_SHA,
          id: 'pr-row-1',
          workflow: { temporalWorkflowId: 'wf-ci-1' },
        },
      ];
      const body = JSON.stringify({
        action: 'completed',
        check_run: {
          conclusion: 'failure',
          head_sha: NEXT_SHA,
          html_url: 'https://github.com/acme/payments-api/runs/2',
        },
        repository: { full_name: 'acme/payments-api' },
      });
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(200);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/2', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
      expect(prCiStatus.get('pr-row-1')).toBe('FAILED');
    });

    it('on a partial multi-workflow failure, rolls back only the failed PR', async () => {
      // Per-PR recovery: the PR that was signaled keeps its new ciStatus, so a
      // redelivery cannot double-fire its workflow; only the failed PR is
      // reverted and re-signaled.
      openPrs = [
        {
          ciStatus: 'PENDING',
          headSha: HEAD_SHA,
          id: 'pr-row-1',
          workflow: { temporalWorkflowId: 'wf-ci-1' },
        },
        {
          ciStatus: 'PENDING',
          headSha: HEAD_SHA,
          id: 'pr-row-2',
          workflow: { temporalWorkflowId: 'wf-ci-2' },
        },
      ];
      signalFailWorkflowIds.add('wf-ci-2');
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.payload).error.message).toContain('1 of 2');
      expect(signalCalls.map((c) => c.workflowId)).toEqual(['wf-ci-1', 'wf-ci-2']);
      // Only pr-row-2 is reverted; pr-row-1 keeps FAILED.
      expect(updateManyCalls.slice(2)).toEqual([
        {
          data: { ciStatus: 'PENDING' },
          where: { ciStatus: 'FAILED', headSha: HEAD_SHA, id: 'pr-row-2' },
        },
      ]);

      // Redelivery: pr-row-1 is already FAILED (count 0 → not transitioned),
      // pr-row-2 is back at PENDING and transitions again.
      signalFailWorkflowIds.clear();
      signalCalls.length = 0;
      updateManyCalls.length = 0;
      updateManyResultCounts = [0, 1];
      const retried = await inject('/api/v1/webhooks/ci', body, sign(body));

      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.payload).data).toEqual({
        conclusion: 'failure',
        signaled: ['wf-ci-2'],
      });
      expect(signalCalls.map((c) => c.workflowId)).toEqual(['wf-ci-2']);
    });

    it('ignores check_run events when no tracked PR matches the commit', async () => {
      openPrs = [];
      const body = ciPayload('failure');
      const res = await inject('/api/v1/webhooks/ci', body, sign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data).toEqual({
        ignored: true,
        reason: 'No tracked PR for this commit',
      });
      expect(signalCalls).toHaveLength(0);
    });
  });

  // ── POST /api/v1/webhooks/jira ──

  describe('POST /jira', () => {
    const JIRA_SECRET = 'jira-webhook-secret';

    function jiraSign(body: string, secret = JIRA_SECRET): string {
      return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    }

    function transitionPayload(toName: string, issueKey = 'PROJ-42'): string {
      return JSON.stringify({
        issue: { fields: { summary: 'Add health endpoint' }, key: issueKey },
        transition: { to: { name: toName } },
      });
    }

    // Fail-closed posture requires a configured secret for every request in
    // this block by default; the dedicated "fails closed" test below unsets it.
    beforeEach(() => {
      state.jira = { ...state.jira, webhookSecret: JIRA_SECRET };
    });

    it('fails closed with 401 when no webhook secret is configured, even with a valid-looking signature', async () => {
      state.jira = { ...state.jira, webhookSecret: null };
      const body = transitionPayload('Ready for Dev');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.payload).error).toBe('Jira webhook secret not configured');
      expect(jiraStartCalls).toHaveLength(0);
    });

    it('returns 401 when signature is required but missing', async () => {
      const res = await inject('/api/v1/webhooks/jira', JSON.stringify({}));
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when signature is wrong', async () => {
      const body = transitionPayload('Ready for Dev');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body, 'wrong-secret'));
      expect(res.statusCode).toBe(401);
    });

    it('skips non-transition payloads', async () => {
      const body = JSON.stringify({});
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ skipped: true });
      expect(jiraStartCalls).toHaveLength(0);
    });

    it("skips when transition.to.name doesn't match webhookTriggerStatus", async () => {
      const body = transitionPayload('In Progress');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ skipped: true });
      expect(jiraStartCalls).toHaveLength(0);
    });

    it('skips when there is no active default template', async () => {
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      jiraPrismaState.defaultTemplate = null;
      const body = transitionPayload('Ready for Dev');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        reason: 'no active default template',
        skipped: true,
      });
      expect(jiraStartCalls).toHaveLength(0);
    });

    it('starts the workflow and records the RunInput + ActiveWorkflow on a valid signed transition', async () => {
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      const body = transitionPayload('Ready for Dev', 'PROJ-99');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true, ticketId: 'PROJ-99' });

      expect(jiraStartCalls).toHaveLength(1);
      expect(jiraStartCalls[0].id).toBe('jira-PROJ-99');
      expect(jiraStartCalls[0].args).toMatchObject({
        request: expect.objectContaining({
          externalTicketId: 'PROJ-99',
          repoId: 'conn-1',
        }),
        templateId: 'tpl-1',
        templateVersion: 1,
      });

      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(1);
      expect(jiraPrismaState.runInputCreateCalls[0]).toMatchObject({
        connectionId: 'conn-1',
        externalTicketId: 'PROJ-99',
      });
      expect(jiraPrismaState.activeWorkflowCreateCalls).toHaveLength(1);
      expect(jiraPrismaState.activeWorkflowCreateCalls[0]).toMatchObject({
        repoId: 'conn-1',
        temporalWorkflowId: 'jira-PROJ-99',
      });
    });

    it('is once-ever per ticket: a redelivered transition starts no second workflow', async () => {
      // The property the auto-trigger actually promises. Delivered twice, the
      // second insert hits the unique index on `temporal_workflow_id` and the
      // workflow is never started again — dedup that outlives Temporal's
      // execution retention, unlike the AlreadyStarted fallback.
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      const body = transitionPayload('Ready for Dev', 'PROJ-100');

      const first = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.payload)).toEqual({ ok: true, ticketId: 'PROJ-100' });

      const second = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.payload)).toEqual({
        duplicate: true,
        ok: true,
        ticketId: 'PROJ-100',
      });

      // Exactly one run: one workflow start, one surviving ledger row.
      expect(jiraStartCalls).toHaveLength(1);
      expect(jiraPrismaState.activeWorkflowCreateCalls).toHaveLength(1);
      expect(jiraPrismaState.rows.size).toBe(1);
    });

    it('rolls the ledger back when the workflow reports already-started', async () => {
      // Fallback gate: the row inserted fine (e.g. a prior orphaned execution
      // Temporal still remembers), so the rows we just wrote are compensated
      // away rather than left wedging the ticket.
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      jiraStartShouldConflict = true;
      const body = transitionPayload('Ready for Dev', 'PROJ-101');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ duplicate: true, ok: true, ticketId: 'PROJ-101' });
      // Rows were written, then rolled back — nothing is left behind.
      expect(jiraPrismaState.activeWorkflowCreateCalls).toHaveLength(1);
      expect(jiraPrismaState.activeWorkflowDeleteCalls).toBe(1);
      expect(jiraPrismaState.rows.size).toBe(0);
    });

    it('a transient start failure does not wedge the ticket — a redelivery succeeds', async () => {
      // The regression this PR exists to prevent. Under the old ordering the
      // ledger row was never written, so a later delivery re-derived the same
      // deterministic ID and Temporal refused it — the ticket stayed
      // unsubmittable with nothing in the DB to explain why. With
      // ledger-then-start + rollback, the retry just works.
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      const body = transitionPayload('Ready for Dev', 'PROJ-102');

      jiraStartFailure = new Error('temporal unreachable');
      const failed = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(failed.statusCode).toBe(500);
      // Rolled back, so the deterministic ID is free again.
      expect(jiraPrismaState.rows.size).toBe(0);

      jiraStartFailure = null;
      const retried = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(retried.statusCode).toBe(200);
      expect(JSON.parse(retried.payload)).toEqual({ ok: true, ticketId: 'PROJ-102' });
      expect(jiraStartCalls).toHaveLength(1);
      expect(jiraPrismaState.rows.size).toBe(1);
    });
  });
});
