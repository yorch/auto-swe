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
  defaultTemplate: { activeVersion: 1, id: 'tpl-1' } as Record<string, unknown> | null,
  runInputCreateCalls: [] as Record<string, unknown>[],
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    activeWorkflow: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        jiraPrismaState.activeWorkflowCreateCalls.push(args.data);
        return { id: 'aw-1', ...args.data };
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
    },
    workflowTemplate: {
      findFirst: vi.fn(async () => jiraPrismaState.defaultTemplate),
    },
  },
}));

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
  const signalCalls: SignalCall[] = [];
  const evalCreateCalls: Array<Record<string, unknown>> = [];
  let workflowRunRow: { id: string } | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let jiraStartShouldConflict = false;
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
        findMany: async () => openPrs,
        update: async (args: UpdateCall) => {
          updateCalls.push(args);
          return { id: args.where.id };
        },
        updateMany: async (args: UpdateCall) => {
          const idx = updateManyCalls.length;
          updateManyCalls.push(args);
          const count = updateManyResultCounts ? (updateManyResultCounts[idx] ?? 1) : 1;
          return { count };
        },
      },
      workflowRun: {
        findFirst: async () => workflowRunRow,
      },
    } as unknown as never);

    app.decorate('temporal', {
      signalWorkflow: async (workflowId: string, signalName: string, args: unknown[]) => {
        signalCalls.push({ args, signalName, workflowId });
      },
      startRunnableWorkflow: async (id: string, args: unknown) => {
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
    signalCalls.length = 0;
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
    jiraPrismaState.defaultTemplate = { activeVersion: 1, id: 'tpl-1' };
    jiraStartShouldConflict = false;
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
      expect(updateCalls).toEqual([{ data: { status: 'MERGED' }, where: { id: 'pr-row-1' } }]);
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
      openPrs = [{ id: 'pr-row-1', workflow: { temporalWorkflowId: 'wf-ci-1' } }];
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
        { data: { ciStatus: 'FAILED' }, where: { ciStatus: { not: 'FAILED' }, id: 'pr-row-1' } },
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
        reason: 'CI status unchanged (duplicate delivery)',
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
        { data: { ciStatus: 'PASSED' }, where: { ciStatus: { not: 'PASSED' }, id: 'pr-row-1' } },
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
        { data: { ciStatus: 'FAILED' }, where: { ciStatus: { not: 'FAILED' }, id: 'pr-row-1' } },
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
        { data: { ciStatus: 'FAILED' }, where: { ciStatus: { not: 'FAILED' }, id: 'pr-row-1' } },
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

    it('returns 200 duplicate without writing RunInput/ActiveWorkflow when the deterministic workflow already exists', async () => {
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      jiraStartShouldConflict = true;
      const body = transitionPayload('Ready for Dev', 'PROJ-100');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ duplicate: true, ok: true, ticketId: 'PROJ-100' });
      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(0);
      expect(jiraPrismaState.activeWorkflowCreateCalls).toHaveLength(0);
    });
  });
});
