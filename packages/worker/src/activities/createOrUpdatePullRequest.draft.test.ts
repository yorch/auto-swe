import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createPr: vi.fn(),
  isDraft: vi.fn(),
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    connection: { findUniqueOrThrow: vi.fn() },
    pullRequest: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: m.prisma }));
vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: vi.fn(() => null),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({})),
  resolveWorkflowDefaults: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/lib/trackerSync', () => ({
  syncTrackerOnEvent: vi.fn(async () => undefined),
}));
vi.mock('@temporalio/activity', async (orig) => ({
  ...(await orig<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ attempt: 1 }),
}));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: () => 'wf-own',
  persistActivityTrace: vi.fn(),
}));
vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    createOrUpdatePullRequest: m.createPr,
    isDraftPullRequest: m.isDraft,
    prUrl: async () => 'https://example.test/pull/5',
  }),
  toRepoRef: () => ({ organizationName: 'acme', repoName: 'api' }),
}));
vi.mock('../lib/slackNotify.js', () => ({ notifySlackPrReady: vi.fn() }));

import {
  DraftPullRequestUnsupportedError,
  ExistingPullRequestNotDraftError,
} from '../lib/scm/types.js';
import { createOrUpdatePullRequest } from './createOrUpdatePullRequest.js';

const request = {
  description: 'd',
  externalTicketId: 'T-1',
  repoId: 'repo-1',
  workRequestId: 'wr-1',
} as RepoWorkRequest;
const codeResult = {
  branch: 'auto/T-1',
  filesChanged: [],
  headSha: 'abc',
  implementationNotes: '',
  testResults: { passed: true, passing: 1, total: 1 },
} as unknown as CodeResult;

beforeEach(() => {
  vi.clearAllMocks();
  m.prisma.connection.findUniqueOrThrow.mockResolvedValue({ defaultBranch: 'main', id: 'repo-1' });
  m.prisma.pullRequest.findFirst.mockResolvedValue(null);
  m.prisma.activeWorkflow.findFirst.mockResolvedValue({ id: 'w1' });
  m.createPr.mockResolvedValue({ prNumber: 7, prUrl: 'https://example.test/pull/7' });
});

describe('createOrUpdatePullRequest draft option', () => {
  it('asks the host for a draft only when told to', async () => {
    await createOrUpdatePullRequest(request, codeResult, { draft: true });
    expect(m.createPr).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
  });

  it('leaves the host request untouched by default, as before', async () => {
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.createPr.mock.calls[0]?.[0]).not.toHaveProperty('draft');
    await createOrUpdatePullRequest(request, codeResult, { draft: false });
    expect(m.createPr.mock.calls[1]?.[0]).not.toHaveProperty('draft');
  });

  it('fails non-retryably when the repository cannot hold drafts, and opens nothing else', async () => {
    m.createPr.mockRejectedValue(new DraftPullRequestUnsupportedError('acme/api: no drafts'));
    await expect(
      createOrUpdatePullRequest(request, codeResult, { draft: true })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'DRAFT_PR_UNSUPPORTED' });
    // No second, ready-for-review attempt and no tracking row for a PR that does not exist.
    expect(m.createPr).toHaveBeenCalledTimes(1);
    expect(m.prisma.pullRequest.create).not.toHaveBeenCalled();
  });

  it('lets any other host error through unchanged', async () => {
    const boom = new Error('boom');
    m.createPr.mockRejectedValue(boom);
    await expect(createOrUpdatePullRequest(request, codeResult, { draft: true })).rejects.toBe(
      boom
    );
  });
});

describe('which ledger row a new PR is linked to', () => {
  it("links the row of the executing workflow, not another row of the same work request's", async () => {
    m.prisma.activeWorkflow.findFirst.mockImplementation(
      async (args: { where: { temporalWorkflowId?: string } }) =>
        args.where.temporalWorkflowId === 'wf-own' ? { id: 'own-row' } : { id: 'anchor-row' }
    );
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.prisma.pullRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workflowId: 'own-row' }),
    });
  });

  it('falls back to the work request lookup when the executing workflow has no row of its own', async () => {
    m.prisma.activeWorkflow.findFirst.mockImplementation(
      async (args: { where: { temporalWorkflowId?: string } }) =>
        args.where.temporalWorkflowId ? null : { id: 'request-row' }
    );
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.prisma.pullRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workflowId: 'request-row' }),
    });
  });
});

describe('createOrUpdatePullRequest with a PR already recorded for the work request', () => {
  beforeEach(() => {
    m.prisma.pullRequest.findFirst.mockResolvedValue({ id: 'pr-row', prNumber: 5 });
  });

  it('refuses, non-retryably, to add commits to one that is ready for review', async () => {
    m.isDraft.mockResolvedValue(false);
    await expect(
      createOrUpdatePullRequest(request, codeResult, { draft: true })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'EXISTING_PR_NOT_DRAFT' });
    expect(m.prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('carries on with one that is still a draft', async () => {
    m.isDraft.mockResolvedValue(true);
    await expect(
      createOrUpdatePullRequest(request, codeResult, { draft: true })
    ).resolves.toMatchObject({ prNumber: 5 });
    expect(m.prisma.pullRequest.update).toHaveBeenCalled();
  });

  it('does not spend an API call on the draft state when no draft was asked for', async () => {
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.isDraft).not.toHaveBeenCalled();
  });
});

describe('createOrUpdatePullRequest when the host would reuse a ready PR', () => {
  it('fails non-retryably instead of pushing onto it', async () => {
    m.createPr.mockRejectedValue(new ExistingPullRequestNotDraftError('acme/api#9 is open'));
    await expect(
      createOrUpdatePullRequest(request, codeResult, { draft: true })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'EXISTING_PR_NOT_DRAFT' });
    expect(m.prisma.pullRequest.create).not.toHaveBeenCalled();
  });
});
