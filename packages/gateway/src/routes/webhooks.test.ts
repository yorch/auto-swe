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
  resolveSlackConfig: vi.fn(async () => ({
    botToken: null,
    clientId: null,
    clientSecret: null,
    signingSecret: null,
  })),
}));

vi.mock('@auto-swe/shared/lib/trackerSync', () => ({
  syncTrackerOnEvent: vi.fn(async () => {}),
}));

// Module-level prisma used directly by the /jira route handler.
// Mutable per-test via jiraPrismaState.
const jiraPrismaState = vi.hoisted(() => ({
  activeRepo: null as Record<string, unknown> | null,
  runInputCreateCalls: [] as Record<string, unknown>[],
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
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
      findFirst: vi.fn(async () => ({ activeVersion: 1, id: 'tpl-1' })),
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
  const signalCalls: SignalCall[] = [];
  const evalCreateCalls: Array<Record<string, unknown>> = [];
  let workflowRunRow: { id: string } | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

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
      },
      workflowRun: {
        findFirst: async () => workflowRunRow,
      },
    } as unknown as never);

    app.decorate('temporal', {
      signalWorkflow: async (workflowId: string, signalName: string, args: unknown[]) => {
        signalCalls.push({ args, signalName, workflowId });
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
      runs: Array<{ status: string; conclusion: string | null; html_url: string }>
    ) {
      return { json: async () => ({ check_runs: runs }), ok: true };
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
      expect(updateCalls).toEqual([{ data: { ciStatus: 'FAILED' }, where: { id: 'pr-row-1' } }]);
      expect(signalCalls).toEqual([
        {
          args: [{ logsUrl: 'https://github.com/acme/payments-api/runs/1', passed: false }],
          signalName: 'ciPipelineSignal',
          workflowId: 'wf-ci-1',
        },
      ]);
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
        `https://api.github.com/repos/acme/payments-api/commits/${HEAD_SHA}/check-runs?per_page=100`,
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
      expect(updateCalls).toEqual([{ data: { ciStatus: 'PASSED' }, where: { id: 'pr-row-1' } }]);
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
      expect(updateCalls).toEqual([{ data: { ciStatus: 'FAILED' }, where: { id: 'pr-row-1' } }]);
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

    it('skips non-transition payloads', async () => {
      const res = await inject('/api/v1/webhooks/jira', JSON.stringify({}));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ skipped: true });
      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(0);
    });

    it("skips when transition.to.name doesn't match webhookTriggerStatus", async () => {
      const body = transitionPayload('In Progress');
      const res = await inject('/api/v1/webhooks/jira', body);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ skipped: true });
      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(0);
    });

    it('creates a work request when transition matches', async () => {
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      const body = transitionPayload('Ready for Dev', 'PROJ-42');
      const res = await inject('/api/v1/webhooks/jira', body);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true, ticketId: 'PROJ-42' });
      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(1);
      expect(jiraPrismaState.runInputCreateCalls[0]).toMatchObject({
        connectionId: 'conn-1',
        externalTicketId: 'PROJ-42',
      });
    });

    it('returns 401 when signature is required but missing', async () => {
      state.jira = { ...state.jira, webhookSecret: JIRA_SECRET };
      const res = await inject('/api/v1/webhooks/jira', JSON.stringify({}));
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when signature is wrong', async () => {
      state.jira = { ...state.jira, webhookSecret: JIRA_SECRET };
      const body = transitionPayload('Ready for Dev');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body, 'wrong-secret'));
      expect(res.statusCode).toBe(401);
    });

    it('accepts a valid HMAC-SHA256 signature and creates the work request', async () => {
      state.jira = { ...state.jira, webhookSecret: JIRA_SECRET };
      jiraPrismaState.activeRepo = { id: 'conn-1', isActive: true, type: 'git_repo' };
      const body = transitionPayload('Ready for Dev', 'PROJ-99');
      const res = await inject('/api/v1/webhooks/jira', body, jiraSign(body));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true, ticketId: 'PROJ-99' });
      expect(jiraPrismaState.runInputCreateCalls).toHaveLength(1);
    });
  });
});
