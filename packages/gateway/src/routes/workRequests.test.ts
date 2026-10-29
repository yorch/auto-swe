import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Org spend comes from the mock's `orgMonthlyUsage` row (see test/billingMock.ts).
vi.mock('@auto-swe/shared/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('../test/billingMock.js')),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubBaseUrl: vi.fn(async () => 'https://github.com'),
  resolveIssueTrackerConfig: vi.fn(async () => ({
    apiToken: null,
    baseUrl: null,
    email: null,
    provider: null,
  })),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({
    apiToken: null,
    baseUrl: null,
    email: null,
    enabled: false,
    maxPages: 10,
    provider: null,
    spaces: [],
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

// The identity lookup needs a connection table these route mocks do not model.
// Mocked once, controllably: a second, static mock of the same module made
// which one applied an accident of hoisting order, and tests that configure
// this one passed or failed with it.
const sameRepositoryIds = vi.hoisted(() => vi.fn());
vi.mock('@auto-swe/shared/lib/sameRepositoryIds', () => ({ sameRepositoryIds }));
vi.mock('../lib/issueTrackerClient.js', () => ({
  fetchTicket: vi.fn(async () => null),
}));
// Only the tracker allowlist is controllable; every other setting resolves as before.
const trackerIssueRepositories = vi.hoisted(() => ({
  ctx: [] as unknown[],
  fail: false,
  value: [] as string[],
}));
vi.mock('@auto-swe/shared/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@auto-swe/shared/config')>();
  return {
    ...original,
    resolveSetting: async (...args: Parameters<typeof original.resolveSetting>) => {
      if (args[0] !== 'github.trackerIssueRepositories') {
        return original.resolveSetting(...args);
      }
      trackerIssueRepositories.ctx.push(args[1]);
      if (trackerIssueRepositories.fail) {
        throw new Error('settings unavailable');
      }
      return trackerIssueRepositories.value;
    },
  };
});

import { resolveIssueTrackerConfig } from '@auto-swe/shared/lib/systemConfig';
import { TRACKER_READ_OUT_OF_SCOPE } from '@auto-swe/shared/lib/trackerSync';
import { experimentBucket } from '../lib/experimentBucket.js';
import { fetchTicket } from '../lib/issueTrackerClient.js';
import { clearStopNodeCache } from '../lib/unchangedRerun.js';
import { resolveDefaultTemplate, workRequestRoutes } from './workRequests.js';

const resolveIssueTrackerConfigMock = vi.mocked(resolveIssueTrackerConfig);
const fetchTicketMock = vi.mocked(fetchTicket);

describe('POST /api/v1/work-requests', () => {
  const app = Fastify();
  // Per-test control over allocateWorkflowId's view of prior executions.
  let existingWorkflows: Array<{
    currentStatus: string;
    repoId?: string | null;
    temporalWorkflowId: string;
  }> = [];
  const startedWorkflowIds: string[] = [];
  const snapshotUpserts: Record<string, unknown>[] = [];
  // Per-test control over the resolved template's inputSchema (P3). Null =
  // no schema → submit validation is skipped (the default for most tests).
  let templateInputSchema: unknown = null;
  // Per-test control over the P5 org-access + budget-cap guards. Defaults make
  // every test pass them (member of the org, no cap, no prior spend).
  let orgMembershipRole: string | null = 'ORG_MEMBER';
  let orgBudgetCents: number | null = null;
  /** The repo's installation. Null is "the singleton's", which is the default. */
  let installation: { installationId: string; isActive: boolean } | null = null;
  let orgSpentUsd: number | null = null;
  // The repository's web base override; null is the instance host.
  let repoGithubUrl: string | null = null;
  // What the not-actionable-stop lookup finds for the next request.
  let notActionableStops: unknown[] = [];
  let stopLookups = 0;
  const createdRunInputs: Record<string, unknown>[] = [];
  const stoppedRequest = {
    id: 'run-stopped',
    startedAt: new Date(),
    workRequest: {
      description: 'Add health endpoint',
      payload: {
        budget: 'STANDARD',
        connectionId: 'repo-1',
        description: 'Add health endpoint',
        ticketId: 'jira-3',
      },
    },
    workRequestId: 'wr-stopped',
  };

  beforeAll(async () => {
    sameRepositoryIds.mockImplementation(async (_p: unknown, id: string) => [id]);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Mock auth plugin — verifyAccessToken accepts any non-empty token in tests
    app.decorate('auth', {
      verifyAccessToken: (token: string) => {
        if (!token) {
          throw new Error('No token');
        }
        return { exp: 9999999999, iat: 0, role: 'ENGINEER', sub: 'user-1' };
      },
    } as unknown as never);

    // Mock prisma and temporal on the app instance (cast through unknown to bypass strict typing)
    const prismaMock = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [],
      // The launch path writes its ledger rows in one transaction; the array
      // form just resolves the queued promises in order.
      $transaction: async (arg: unknown) => {
        if (Array.isArray(arg)) {
          return Promise.all(arg);
        }
        if (typeof arg === 'function') {
          return arg(prismaMock);
        }
        return undefined;
      },
      activeWorkflow: {
        create: async (args: { data: Record<string, unknown> }) => ({
          id: 'wf-1',
          ...args.data,
        }),
        delete: async () => ({}),
        findMany: async () => existingWorkflows,
      },
      connection: {
        findUnique: async () => ({
          githubUrl: repoGithubUrl,
          id: 'repo-1',
          installation,
          isActive: true,
          organizationName: 'org',
          repoName: 'test',
          shares: [],
          team: {
            memberships: [{ userId: 'user-1' }],
            organization: { id: 'org-1', monthlyBudgetUsdCents: orgBudgetCents },
            orgId: 'org-1',
          },
          teamId: 'team-1',
          type: 'git_repo',
        }),
      },
      contextSnapshot: {
        upsert: async (args: Record<string, unknown>) => {
          snapshotUpserts.push(args);
          return { id: 'cs-1' };
        },
      },
      organizationMembership: {
        findUnique: async () => (orgMembershipRole ? { role: orgMembershipRole } : null),
      },
      orgMonthlyUsage: {
        findUnique: async () => (orgSpentUsd != null ? { costUsdAccrued: orgSpentUsd } : null),
      },
      runInput: {
        create: async (args: { data: Record<string, unknown> }) => {
          createdRunInputs.push(args.data);
          return { id: 'wr-1', ...args.data };
        },
        delete: async () => ({}),
      },
      // The first lookup is the stops; the second, the runs after one.
      workflowRun: {
        findMany: async () => {
          stopLookups += 1;
          return stopLookups % 2 === 1 ? notActionableStops : [];
        },
      },
      workflowTemplate: {
        findFirst: async () => ({
          activeVersion: 1,
          id: 'tpl-1',
        }),
        findUnique: async () => ({ inputSchema: templateInputSchema }),
      },
      workflowTemplateVersion: {
        findFirst: async () => ({
          spec: { nodes: { terminateNotActionable: { status: 'FAILED', type: 'terminate' } } },
        }),
      },
    };
    app.decorate('prisma', prismaMock as unknown as never);
    app.decorate('temporal', {
      cancelWorkflow: async () => {},
      deleteChannelAmbientSchedule: async () => {},
      deleteChannelReactiveSchedule: async () => {},
      deleteWorkRequestSchedule: async () => {},
      explainWorkflowSpec: async () => ({ explanation: 'does a thing' }),
      generateWorkflowSpec: async () => ({
        attempts: 1,
        spec: {
          description: '',
          entry: 'done',
          name: 'generated',
          nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
          schemaVersion: 1,
        },
        summary: '',
      }),
      getChannelAmbientScheduleStatus: async () => ({
        exists: false,
        nextRunAt: null,
        paused: false,
      }),
      getConsolidationScheduleStatus: async () => ({
        exists: false,
        nextRunAt: null,
        paused: false,
      }),
      getEvalScheduleStatus: async () => ({
        exists: false,
        lastRunAt: null,
        nextRunAt: null,
        paused: false,
      }),
      getRepoDependencyScanScheduleStatus: async () => ({
        exists: false,
        lastRunAt: null,
        nextRunAt: null,
        paused: false,
      }),
      getRevalidationScheduleStatus: async () => ({
        exists: false,
        lastRunAt: null,
        nextRunAt: null,
        paused: false,
      }),
      getWorkflowAuthorJobStatus: async () => ({ phase: 'generating', status: 'running' }),
      getWorkRequestScheduleStatus: async () => ({
        exists: false,
        lastRunAt: null,
        nextRunAt: null,
        paused: false,
      }),
      isReembedStaleMemoryRunning: async () => false,
      isWorkflowGone: async () => false,
      isWorkflowRunning: async () => false,
      nameAssistantConversation: async () => {},
      probeExecutorImage: async () => ({ checks: [], image: 'x', ok: true }),
      sendAssistantTurn: async () => {},
      signalWorkflow: async () => {},
      startChannelAssistant: async () => {},
      startConsolidationWorkflow: async () => {},
      startEpicWorkflow: async () => {},
      startEvalRunWorkflow: async () => {},
      startEvalScreenWorkflow: async () => {},
      startPrEvaluationWorkflow: async () => {},
      startReembedMemory: async () => {},
      startReembedStaleMemory: async () => true,
      startRepoDependencyInference: async () => {},
      startRepoDependencyScan: async () => {},
      startRunnableWorkflow: async (id: string) => {
        startedWorkflowIds.push(id);
      },
      startWorkflowAuthorJob: async () => {},
      syncAgentTraceRollupSchedule: async () => {},
      syncAgentTranscriptPruneSchedule: async () => {},
      syncAuditActivityPruneSchedule: async () => {},
      syncAutomationDecisionPruneSchedule: async () => {},
      syncCallbackDeliveryPruneSchedule: async () => {},
      syncCallbackDeliverySchedule: async () => {},
      syncChannelAmbientSchedule: async () => {},
      syncChannelReactiveSchedule: async () => {},
      syncConsolidationSchedule: async () => {},
      syncEvalSchedule: async () => {},
      syncModelDiscoverySchedule: async () => {},
      syncRepoAccessSyncSchedule: async () => {},
      syncRepoDependencyScanSchedule: async () => {},
      syncReportDigestSchedule: async () => {},
      syncRevalidationSchedule: async () => {},
      syncRunReaperSchedule: async () => {},
      syncSkillSourceSyncSchedule: async () => {},
      syncSlackChannelSyncSchedule: async () => {},
      syncWorkflowRunRollupSchedule: async () => {},
      syncWorkRequestSchedule: async () => {},
      triggerConsolidationNow: async () => {},
      triggerEvalNow: async () => {},
      triggerRepoDependencyScanNow: async () => {},
      triggerReportDigestTest: async () => {},
      triggerRevalidationNow: async () => {},
      triggerWorkRequestSchedule: async () => {},
      workflowSettledStatus: async () => null,
    });

    await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
    await app.ready();
  });

  afterAll(() => app.close());

  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing description', async () => {
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: { externalTicketId: 'JIRA-1', repoIds: ['00000000-0000-4000-8000-000000000001'] },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a work request', async () => {
    existingWorkflows = [];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.data.workRequestId).toBeDefined();
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1');
  });

  it('returns 403 when the submitter is not a member of the org (P5 row isolation)', async () => {
    existingWorkflows = [];
    orgMembershipRole = null; // not a member of org-1
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-403',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    orgMembershipRole = 'ORG_MEMBER'; // restore default
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error.code).toBe('FORBIDDEN');
  });

  it('returns 403 INSTALLATION_RETIRED when the repo points at a retired installation', async () => {
    // The only end-to-end assertion that a gated route actually refuses. Every
    // other test of this covers the pure decision function, and no route
    // fixture set an `installation` at all — so the branch was never taken
    // through a real request, and a route that dropped the check would have
    // stayed green.
    existingWorkflows = [];
    installation = { installationId: '900001', isActive: false };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-RETIRED',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    installation = null; // restore default
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('INSTALLATION_RETIRED');
    expect(body.error.reason).toBe('installation-retired');
  });

  it('accepts the same request through a live installation', async () => {
    // The discriminating case: if the test above passed because ANY
    // installation refused, or because the route refuses everything, this
    // would fail.
    existingWorkflows = [];
    installation = { installationId: '900001', isActive: true };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-LIVE',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    installation = null;
    expect(res.statusCode).toBe(201);
  });

  it('returns 402 when the org has exceeded its monthly budget cap (P5 billing)', async () => {
    existingWorkflows = [];
    orgBudgetCents = 100; // $1.00 cap
    orgSpentUsd = 5; // $5.00 already accrued → 500 cents >= 100
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-402',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    orgBudgetCents = null; // restore defaults
    orgSpentUsd = null;
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.payload).error.code).toBe('ORG_BUDGET_EXCEEDED');
  });

  it('allows submission when accrued spend is below the cap (P5 billing)', async () => {
    existingWorkflows = [];
    orgBudgetCents = 100_000; // $1000 cap
    orgSpentUsd = 5; // $5 accrued → 500 cents < 100000
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-OK-BUDGET',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    orgBudgetCents = null;
    orgSpentUsd = null;
    expect(res.statusCode).toBe(201);
  });

  it('accepts a submission that satisfies the template inputSchema', async () => {
    existingWorkflows = [];
    templateInputSchema = {
      properties: { description: { type: 'string' }, ticketId: { type: 'string' } },
      required: ['ticketId', 'description'],
      type: 'object',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-OK',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    templateInputSchema = null;
    expect(res.statusCode).toBe(201);
  });

  it('rejects a submission that violates the template inputSchema', async () => {
    existingWorkflows = [];
    const before = startedWorkflowIds.length;
    // Require a field the server-built payload never supplies → 400, no Temporal start.
    templateInputSchema = {
      properties: { approvalToken: { type: 'string' } },
      required: ['approvalToken'],
      type: 'object',
    };
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-BAD',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    templateInputSchema = null;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(body.error.details).toContain("'approvalToken' is required");
    // Validation happens before the idempotency gate — no workflow was started.
    expect(startedWorkflowIds.length).toBe(before);
  });

  it('returns 409 when an execution for the ticket is still running', async () => {
    existingWorkflows = [
      { currentStatus: 'IMPLEMENTING', temporalWorkflowId: 'eng-org-test-JIRA-1' },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.code).toBe('WORKFLOW_ALREADY_EXISTS');
  });

  it("does not name another row's workflow id when that row is the same repository", async () => {
    sameRepositoryIds.mockImplementation(async (_p: unknown, id: string) => [id, 'other-row']);
    existingWorkflows = [
      {
        currentStatus: 'IMPLEMENTING',
        repoId: 'other-row',
        temporalWorkflowId: 'eng-org-test-JIRA-1',
      },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(409);
    const { message } = JSON.parse(res.payload).error;
    expect(message).toContain('for this repository');
    expect(message).not.toContain('eng-org-test-JIRA-1');
    sameRepositoryIds.mockImplementation(async (_p: unknown, id: string) => [id]);
  });

  it('returns 409 for a host-qualified repo whose ticket is still running under its old id', async () => {
    // Ids gained a host segment for repositories on another host. A run that
    // started before that, under `eng-org-test-…`, is the same ticket on the
    // same repository and must block a second one pushing the same branch.
    repoGithubUrl = 'https://ghe.corp';
    existingWorkflows = [
      {
        currentStatus: 'IMPLEMENTING',
        // Ledger rows always carry their repository; the legacy id only blocks
        // for the repository it belongs to.
        repoId: 'repo-1',
        temporalWorkflowId: 'eng-org-test-JIRA-1',
      },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    repoGithubUrl = null;
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error.message).toContain('eng-org-test-JIRA-1');
  });

  it('allocates an -rN workflow ID when re-submitting a finished ticket', async () => {
    existingWorkflows = [{ currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-1' }];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1-r1');
  });

  it('enriches the context snapshot when a tracker is configured and the fetch succeeds', async () => {
    existingWorkflows = [];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockResolvedValueOnce({
      allowPrivateNetwork: false,
      apiToken: 'tok',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      provider: 'jira',
    });
    fetchTicketMock.mockResolvedValueOnce({
      description: 'Full ticket body',
      labels: ['backend'],
      raw: { key: 'JIRA-2' },
      status: 'To Do',
      title: 'Add health endpoint',
      url: 'https://acme.atlassian.net/browse/JIRA-2',
    });

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    // Enrichment runs after the response, so wait for it rather than assuming it.
    await vi.waitFor(() => expect(snapshotUpserts).toHaveLength(1));
    const upsert = snapshotUpserts[0] as {
      create: { rawTicketData: { title: string }; workRequestId: string };
      where: { workRequestId: string };
    };
    expect(upsert.create.rawTicketData.title).toBe('Add health endpoint');
    expect(upsert.where.workRequestId).toBe(JSON.parse(res.payload).data.workRequestId);
    // The repo the request targets is passed as the bare-number fallback for GitHub IDs.
    expect(fetchTicketMock.mock.calls[0]?.[2]?.defaultRepo).toEqual({
      owner: 'org',
      repo: 'test',
    });
  });

  it('answers 201 without waiting for a slow tracker', async () => {
    existingWorkflows = [];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockResolvedValueOnce({
      allowPrivateNetwork: false,
      apiToken: 'tok',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      provider: 'jira',
    });
    // A tracker that never answers must not hold the submission open.
    fetchTicketMock.mockReturnValueOnce(new Promise(() => undefined));

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-SLOW',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(0);
  });

  describe('after a not-actionable stop', () => {
    const submit = (extra: Record<string, unknown> = {}) =>
      app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'POST',
        payload: {
          description: 'Add health endpoint',
          externalTicketId: 'JIRA-3',
          repoIds: ['00000000-0000-4000-8000-000000000001'],
          ...extra,
        },
        url: '/api/v1/work-requests',
      });

    beforeEach(() => {
      clearStopNodeCache();
      stopLookups = 0;
      createdRunInputs.length = 0;
    });

    it('refuses an unchanged request with 409 naming the earlier run, and starts nothing', async () => {
      existingWorkflows = [];
      notActionableStops = [stoppedRequest];
      startedWorkflowIds.length = 0;
      const res = await submit();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'UNCHANGED_AFTER_NOT_ACTIONABLE',
        details: { previousRunId: 'run-stopped' },
      });
      expect(startedWorkflowIds).toHaveLength(0);
    });

    it('launches when acknowledged, and when the description changed', async () => {
      existingWorkflows = [];
      notActionableStops = [stoppedRequest];
      expect((await submit({ acknowledgeUnchanged: true })).statusCode).toBe(201);
      expect(String(createdRunInputs[0].requestPayload)).not.toContain('acknowledgeUnchanged');
      existingWorkflows = [];
      expect((await submit({ description: 'Add a readiness endpoint' })).statusCode).toBe(201);
      notActionableStops = [];
    });
  });

  it('still returns 201 and writes no snapshot when the tracker fetch fails', async () => {
    existingWorkflows = [{ currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2' }];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockResolvedValueOnce({
      allowPrivateNetwork: false,
      apiToken: 'tok',
      baseUrl: 'https://acme.atlassian.net',
      email: 'bot@acme.com',
      provider: 'jira',
    });
    fetchTicketMock.mockResolvedValueOnce(null); // 404 / timeout / network error

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(0);
  });

  describe('GitHub tracker reads', () => {
    const githubTracker = (baseUrl: string | null = null) => ({
      allowPrivateNetwork: false,
      apiToken: 'tok',
      baseUrl,
      email: null,
      provider: 'github' as const,
    });
    const submit = (externalTicketId: string) =>
      app.inject({
        headers: { authorization: 'Bearer test-token' },
        method: 'POST',
        payload: {
          description: 'Add health endpoint',
          externalTicketId,
          repoIds: ['00000000-0000-4000-8000-000000000001'],
        },
        url: '/api/v1/work-requests',
      });
    const ticket = {
      description: 'body',
      labels: [],
      raw: {},
      status: 'open',
      title: 'An issue',
      url: 'https://github.com/org/test/issues/5',
    };

    // A queued `Once` value or call history must not reach the next test (mockReset restores
    // the factory's default implementation).
    afterEach(() => {
      resolveIssueTrackerConfigMock.mockReset();
      fetchTicketMock.mockReset();
      trackerIssueRepositories.ctx = [];
      trackerIssueRepositories.fail = false;
      trackerIssueRepositories.value = [];
    });

    // Enrichment runs after the response; the fixed warn line proves it ran and refused.
    const expectRefused = async (externalTicketId: string) => {
      const warn = vi.spyOn(app.log, 'warn');
      try {
        expect((await submit(externalTicketId)).statusCode).toBe(201);
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.anything(), TRACKER_READ_OUT_OF_SCOPE)
        );
        expect(fetchTicketMock).not.toHaveBeenCalled();
        expect(snapshotUpserts).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    };

    it('does not fetch a ticket from a repository the request does not target', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());

      await expectRefused('attacker/private#1');
    });

    it('does not fetch when the tracker is on another host than the repository', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker('https://ghe.corp/api/v3'));

      await expectRefused('org/test#2');
    });

    it('fetches and stores a ticket in the selected repository, named or bare', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());
      fetchTicketMock.mockResolvedValueOnce(ticket);
      expect((await submit('Org/Test#5')).statusCode).toBe(201);
      await vi.waitFor(() => expect(snapshotUpserts).toHaveLength(1));
      expect(fetchTicketMock).toHaveBeenCalledTimes(1);

      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());
      fetchTicketMock.mockResolvedValueOnce(ticket);
      expect((await submit('6')).statusCode).toBe(201);
      await vi.waitFor(() => expect(snapshotUpserts).toHaveLength(2));
      expect(fetchTicketMock).toHaveBeenCalledTimes(2);
    });

    it('fetches a ticket from a repository the operator listed, resolved at the repo team', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      trackerIssueRepositories.value = ['Org/Issues'];
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());
      fetchTicketMock.mockResolvedValueOnce(ticket);
      expect((await submit('org/issues#5')).statusCode).toBe(201);
      await vi.waitFor(() => expect(snapshotUpserts).toHaveLength(1));
      expect(fetchTicketMock).toHaveBeenCalledTimes(1);
      expect(trackerIssueRepositories.ctx).toContainEqual({ orgId: 'org-1', teamId: 'team-1' });
    });

    it('refuses an unlisted repository whatever the list holds', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      trackerIssueRepositories.value = ['org/issues'];
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());

      await expectRefused('attacker/private#1');
    });

    it('refuses a listed repository when the setting cannot be read', async () => {
      existingWorkflows = [];
      snapshotUpserts.length = 0;
      fetchTicketMock.mockClear();
      trackerIssueRepositories.fail = true;
      resolveIssueTrackerConfigMock.mockResolvedValueOnce(githubTracker());

      await expectRefused('org/issues#5');
    });
  });

  it('still returns 201 when the tracker enrichment throws unexpectedly', async () => {
    existingWorkflows = [
      { currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2' },
      { currentStatus: 'FAILED', temporalWorkflowId: 'eng-org-test-JIRA-2-r2' },
    ];
    snapshotUpserts.length = 0;
    resolveIssueTrackerConfigMock.mockRejectedValueOnce(new Error('db unreachable'));

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-2',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(snapshotUpserts).toHaveLength(0);
  });

  it('skips the tracker fetch entirely when no provider is configured', async () => {
    existingWorkflows = [];
    snapshotUpserts.length = 0;
    fetchTicketMock.mockClear();

    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-3',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(fetchTicketMock).not.toHaveBeenCalled();
    expect(snapshotUpserts).toHaveLength(0);
  });

  it('ignores prefix-similar workflow IDs from other tickets when allocating', async () => {
    // 'eng-org-test-JIRA-1-restore' belongs to ticket 'JIRA-1-restore', not a re-run.
    existingWorkflows = [
      { currentStatus: 'IMPLEMENTING', temporalWorkflowId: 'eng-org-test-JIRA-1-restore' },
    ];
    const res = await app.inject({
      headers: { authorization: 'Bearer test-token' },
      method: 'POST',
      payload: {
        description: 'Add health endpoint',
        externalTicketId: 'JIRA-1',
        repoIds: ['00000000-0000-4000-8000-000000000001'],
      },
      url: '/api/v1/work-requests',
    });
    expect(res.statusCode).toBe(201);
    expect(startedWorkflowIds.at(-1)).toBe('eng-org-test-JIRA-1');
  });
});

describe('resolveDefaultTemplate', () => {
  function fakePrisma(opts: {
    teamMatch?: { id: string; activeVersion: number | null } | null;
    globalMatch?: { id: string; activeVersion: number | null } | null;
  }) {
    const findFirst = vi
      .fn()
      .mockImplementationOnce(async () => opts.teamMatch ?? null)
      .mockImplementationOnce(async () => opts.globalMatch ?? null);
    return { findFirst, prisma: { workflowTemplate: { findFirst } } };
  }

  it('prefers the team default over the global default', async () => {
    const { prisma } = fakePrisma({
      globalMatch: { activeVersion: 2, id: 'global-tpl' },
      teamMatch: { activeVersion: 5, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });

  it('falls back to the global default when no team default exists', async () => {
    const { findFirst, prisma } = fakePrisma({
      globalMatch: { activeVersion: 1, id: 'global-tpl' },
      teamMatch: null,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'global-tpl', version: 1 });
    expect(findFirst).toHaveBeenCalledTimes(2);
    const secondWhere = findFirst.mock.calls[1]?.[0]?.where as Record<string, unknown>;
    expect(secondWhere.teamId).toBeNull();
  });

  it('returns null when neither a team nor global default is configured', async () => {
    const { prisma } = fakePrisma({ globalMatch: null, teamMatch: null });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });

  it('returns null when the matched template has no activeVersion', async () => {
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: { activeVersion: null, id: 'team-tpl' },
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toBeNull();
  });

  it('routes to the experiment version when bucket lands below the split', async () => {
    // experimentSplit=100 → every ticket lands in the experiment arm.
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 100,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1',
      'JIRA-1'
    );
    expect(out).toEqual({ isExperiment: true, templateId: 'team-tpl', version: 7 });
  });

  it('stays on the active version when bucket lands above the split', async () => {
    // experimentSplit=0 → no traffic ever enters the experiment arm.
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 0,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1',
      'JIRA-99'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });

  it('ignores the experiment when externalTicketId is not provided', async () => {
    const { prisma } = fakePrisma({
      globalMatch: null,
      teamMatch: {
        activeVersion: 5,
        experimentSplit: 100,
        experimentVersion: 7,
        id: 'team-tpl',
      } as never,
    });
    const out = await resolveDefaultTemplate(
      prisma as unknown as Parameters<typeof resolveDefaultTemplate>[0],
      'team-1'
    );
    expect(out).toEqual({ isExperiment: false, templateId: 'team-tpl', version: 5 });
  });
});

describe('experimentBucket', () => {
  it('is deterministic for a given (templateId, ticketId)', () => {
    const a = experimentBucket('JIRA-42', 'tpl-1');
    const b = experimentBucket('JIRA-42', 'tpl-1');
    expect(a).toBe(b);
  });

  it('returns a value in [0, 100)', () => {
    for (const t of ['JIRA-1', 'PROJ-99', 'AAA-0', 'edge case ticket']) {
      const b = experimentBucket(t, 'tpl-x');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it('decorrelates buckets across templateIds (salt works)', () => {
    // Same ticket, two templates → buckets should generally differ.
    // (Not a strict invariant — birthday collisions are possible — but with
    // sha1 + 100 buckets, picking two distinct templateIds and a fixed ticket
    // hitting the same bucket is 1/100; we test a handful to confirm the
    // salt is actually mixed in.)
    const distinct = new Set<number>();
    for (let i = 0; i < 20; i++) {
      distinct.add(experimentBucket('JIRA-1', `tpl-${i}`));
    }
    expect(distinct.size).toBeGreaterThan(1);
  });
});
