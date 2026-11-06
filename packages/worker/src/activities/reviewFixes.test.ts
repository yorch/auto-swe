import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startReviewFix } from './reviewFixes.js';

const m = vi.hoisted(() => ({
  active: vi.fn(),
  automations: vi.fn(),
  branch: vi.fn(),
  count: vi.fn(),
  decision: vi.fn(),
  fires: new Map<string, Record<string, unknown>>(),
  hostPr: vi.fn(),
  pr: vi.fn(),
  repo: vi.fn(),
  review: vi.fn(),
  runInput: vi.fn(),
  savedInput: vi.fn(),
  settings: {} as Record<string, unknown>,
  start: vi.fn(),
  template: vi.fn(),
}));
vi.mock('@auto-swe/shared/automation', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/automation')>()),
  decideUnderLock: m.decision,
}));
vi.mock('../lib/reviewFeedback.js', async (orig) => ({
  ...(await orig<typeof import('../lib/reviewFeedback.js')>()),
  readReviewFeedback: m.review,
}));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: async (key: string) => m.settings[key],
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
  resolveWorkflowDefaults: async () => ({ branchPrefix: 'auto' }),
}));
vi.mock('../lib/launchAudit.js', () => ({ recordWorkerLaunchAudit: vi.fn() }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start: m.start } }),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    branchInfo: m.branch,
    defaultBranch: async () => 'main',
    pullRequestInfo: m.hostPr,
  }),
  toRepoRef: () => ({ apiUrl: null, baseUrl: null }),
}));
vi.mock('@auto-swe/shared/db', () => {
  const db = {
    activeWorkflow: { create: m.active },
    automation: { findMany: m.automations },
    automationFire: {
      count: m.count,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        m.fires.set(String(data.dedupeKey), data);
        return data;
      },
      findUnique: async ({ where }: { where: { dedupeKey: string } }) =>
        m.fires.get(where.dedupeKey) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { dedupeKey: string };
        data: Record<string, unknown>;
      }) => {
        const row = { ...m.fires.get(where.dedupeKey), ...data };
        m.fires.set(where.dedupeKey, row);
        return row;
      },
    },
    connection: { findUnique: m.repo },
    pullRequest: { findFirst: m.pr },
    runInput: { create: m.runInput, findUnique: m.savedInput },
    workflowTemplate: { findFirst: m.template },
  };
  return { prisma: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) } };
});

const REPO = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const HEAD = 'a'.repeat(40);
const payload = {
  connectionId: REPO,
  onBlocking: 'fix' as const,
  reviewOf: { mode: 'pr' as const, prNumber: 9 },
  sourceRunId: SOURCE,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.fires.clear();
  m.settings = { 'github.ciFixNeverPushBranches': [], 'github.prFeedbackAutomationsEnabled': true };
  m.review.mockResolvedValue({
    headSha: HEAD,
    origin: 'workflow',
    sourceRunId: SOURCE,
    sourceWorkflowId: 'source-wf',
    status: 'RUNNING',
    texts: [],
  });
  m.repo.mockResolvedValue({
    id: REPO,
    installation: null,
    isActive: true,
    organizationName: 'acme',
    repoName: 'api',
    team: { organization: { id: 'org', monthlyBudgetUsdCents: null }, orgId: 'org' },
    teamId: 'team',
    type: 'git_repo',
  });
  m.automations.mockResolvedValue([
    {
      cooldownMinutes: 0,
      enabled: true,
      filters: { pullRequests: ['platform'], triggers: ['review_findings'] },
      id: 'automation',
      inputs: {},
      maxRunsPerDay: 10,
      templateId: null,
    },
  ]);
  m.hostPr.mockResolvedValue({
    headRef: 'auto/source',
    headRepositoryFullName: 'acme/api',
    headSha: HEAD,
    state: 'open',
  });
  m.pr.mockResolvedValue({
    runId: SOURCE,
    workflow: { currentStatus: 'COMPLETED', temporalWorkflowId: 'source-wf' },
  });
  m.branch.mockResolvedValue({ protected: false, sha: HEAD });
  m.template.mockResolvedValue({ activeVersion: 1, id: 'template' });
  m.decision.mockResolvedValue(null);
  m.count.mockResolvedValue(0);
  m.start.mockResolvedValue(undefined);
});

describe('review fix launches', () => {
  it('launches an opted-in built-in feedback round with a real fire and stable ledger identity', async () => {
    const result = await startReviewFix(payload, RUN);
    expect(result.status).toBe('started');
    expect(m.automations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ connection: { teamId: 'team' }, connectionId: REPO }),
      })
    );
    const fire = m.fires.get(`review-fix:${RUN}`);
    expect(fire).toMatchObject({
      facts: { headSha: HEAD, reviewRunId: RUN },
      outcome: 'STARTED',
      ownerKey: 'github.com/acme/api',
      reason: null,
      scopeKey: 'pr-9',
      source: 'github.pull_request.feedback',
      subjectKey: `pr-9@review-${RUN}`,
    });
    expect(m.runInput).toHaveBeenCalledOnce();
    expect(m.active).toHaveBeenCalledOnce();
    expect(m.start).toHaveBeenCalledWith(
      'RunnableWorkflow',
      expect.objectContaining({
        args: [
          expect.objectContaining({
            request: expect.objectContaining({
              payload: expect.objectContaining({
                feedbackEventId: RUN,
                feedbackEventKind: 'review_findings',
                feedbackOrigin: 'workflow',
                feedbackTrigger: 'review_findings',
              }),
            }),
            templateId: 'template',
          }),
        ],
        workflowId: `prfb-review-${RUN}`,
      })
    );
    const request = m.start.mock.calls[0]?.[1].args[0].request;
    expect(request.launchedById).toBeUndefined();
  });
  it('deduplicates completed launches by review run, even after the host head moves', async () => {
    const first = await startReviewFix(payload, RUN);
    m.hostPr.mockResolvedValue({ headSha: 'b'.repeat(40) });
    expect(await startReviewFix(payload, RUN)).toEqual(first);
    expect(m.start).toHaveBeenCalledOnce();
    expect(m.runInput).toHaveBeenCalledOnce();
    expect(m.fires.size).toBe(1);
  });
  it('resumes an interrupted start using its immutable saved payload and template version', async () => {
    await startReviewFix(payload, RUN);
    const firstLaunch = m.start.mock.calls[0]?.[1].args[0];
    const fire = m.fires.get(`review-fix:${RUN}`);
    if (!fire) {
      throw new Error('Missing feedback fire');
    }
    fire.reason = 'starting';
    m.savedInput.mockResolvedValue(m.runInput.mock.calls[0]?.[0].data);
    m.template.mockResolvedValue({ activeVersion: 2, id: 'new-template' });
    await startReviewFix(payload, RUN);
    expect(m.start.mock.calls[1]?.[1].args[0]).toEqual(firstLaunch);
    expect(m.runInput).toHaveBeenCalledOnce();
  });
  it('skips when no repository automation explicitly opts in', async () => {
    m.automations.mockResolvedValue([]);
    expect(await startReviewFix(payload, RUN)).toMatchObject({
      reason: expect.stringContaining('opts in to review_findings'),
      status: 'skipped',
    });
    expect(m.start).not.toHaveBeenCalled();
  });
  it('skips a moved head before creating a feedback fire', async () => {
    m.hostPr.mockResolvedValue({
      headRef: 'auto/source',
      headRepositoryFullName: 'acme/api',
      headSha: 'b'.repeat(40),
      state: 'open',
    });
    expect(await startReviewFix(payload, RUN)).toEqual({
      reason: 'the reviewed head moved',
      status: 'skipped',
    });
    expect(m.fires.size).toBe(0);
  });
  it('counts all pushed feedback rounds on the PR under the normal owner lock', async () => {
    m.count.mockResolvedValue(5);
    expect(await startReviewFix(payload, RUN)).toEqual({
      reason: 'round limit reached',
      status: 'skipped',
    });
    expect(m.count).toHaveBeenCalledWith({
      where: {
        outcome: 'STARTED',
        ownerKey: 'github.com/acme/api',
        producedKey: { not: null },
        scopeKey: 'pr-9',
        source: 'github.pull_request.feedback',
      },
    });
    expect(m.start).not.toHaveBeenCalled();
  });
  it('preserves cooldown, in-flight and daily-cap suppression from the shared engine', async () => {
    m.decision.mockResolvedValue({
      outcome: 'SUPPRESSED_IN_FLIGHT',
      reason: 'an earlier feedback round is working',
    });
    expect(await startReviewFix(payload, RUN)).toMatchObject({
      reason: 'an earlier feedback round is working',
      status: 'skipped',
    });
    expect(m.start).not.toHaveBeenCalled();
  });
  it('keeps agent-run origin so gather selects the original agent, without accepting a replacement agent', async () => {
    m.review.mockResolvedValue({
      headSha: HEAD,
      origin: 'agent_run',
      sourceRunId: SOURCE,
      sourceWorkflowId: 'source-wf',
      status: 'RUNNING',
      texts: [],
    });
    await startReviewFix(payload, RUN);
    expect(m.start.mock.calls[0]?.[1].args[0].request.payload.feedbackOrigin).toBe('agent_run');
  });
  it('records a Temporal start failure without failing review publication', async () => {
    m.start.mockRejectedValueOnce(new Error('unavailable'));
    expect(await startReviewFix(payload, RUN)).toEqual({
      reason: 'the fix workflow could not start',
      status: 'skipped',
    });
    expect(m.fires.get(`review-fix:${RUN}`)?.outcome).toBe('FAILED_TO_START');
  });
});
