import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  createPr: vi.fn(),
  isDraft: vi.fn(),
  kb: { searchPages: vi.fn(), updatePageWithPrLink: vi.fn() },
  prisma: {
    activeWorkflow: { findFirst: vi.fn() },
    connection: { findUniqueOrThrow: vi.fn() },
    pullRequest: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    runInput: { findUnique: vi.fn() },
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: m.prisma }));
vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: vi.fn(() => m.kb),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(),
  resolveKnowledgeBaseConfig: vi.fn(async () => ({})),
  resolveWorkflowDefaults: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/lib/trackerSync', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/trackerSync')>()),
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

import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
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

  it('records the title and whether the PR was opened as a draft', async () => {
    await createOrUpdatePullRequest(request, codeResult, { draft: true });
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.prisma.pullRequest.create.mock.calls[0]?.[0].data).toMatchObject({
      isDraft: true,
      title: '[auto-swe] T-1',
    });
    expect(m.prisma.pullRequest.create.mock.calls[1]?.[0].data).toMatchObject({ isDraft: false });
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

describe('the pull request base', () => {
  it("is the repository's default branch for a run that names no base", async () => {
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.createPr).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'main' }));
  });

  it("is the run's payload base when the code result does not say", async () => {
    await createOrUpdatePullRequest(
      { ...request, payload: { baseBranch: 'release/1.4' } },
      codeResult
    );
    expect(m.createPr).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'release/1.4' }));
  });

  it('is the branch the code result was cut from, which wins', async () => {
    await createOrUpdatePullRequest(
      { ...request, payload: { baseBranch: 'release/1.4' } },
      { ...codeResult, baseBranch: 'release/1.5' }
    );
    expect(m.createPr).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'release/1.5' }));
  });
});

describe('the tracker sync when a PR is opened', () => {
  it.each([
    [true, 0],
    [false, 1],
  ])('with ticketIsSynthetic=%s syncs %i time(s)', async (ticketIsSynthetic, calls) => {
    m.prisma.runInput.findUnique.mockResolvedValue({ ticketIsSynthetic });
    await createOrUpdatePullRequest(request, codeResult);
    expect(syncTrackerOnEvent).toHaveBeenCalledTimes(calls);
  });
});

describe('the knowledge-base PR link write-back when a PR is opened', () => {
  it.each([
    [true, 0],
    [false, 1],
  ])('with ticketIsSynthetic=%s writes the link %i time(s)', async (ticketIsSynthetic, calls) => {
    m.prisma.runInput.findUnique.mockResolvedValue({ ticketIsSynthetic });
    m.kb.searchPages.mockResolvedValue([{ id: 'page-1', title: 'T-1 spec' }]);
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.kb.searchPages).toHaveBeenCalledTimes(calls);
    expect(m.kb.updatePageWithPrLink).toHaveBeenCalledTimes(calls);
  });
});

describe('when the synthetic flag cannot be read', () => {
  it('still syncs the tracker but never writes to the knowledge base', async () => {
    m.prisma.runInput.findUnique.mockRejectedValue(new Error('db down'));
    m.kb.searchPages.mockResolvedValue([{ id: 'page-1', title: 'T-1 spec' }]);
    await createOrUpdatePullRequest(request, codeResult);
    expect(syncTrackerOnEvent).toHaveBeenCalledTimes(1);
    expect(m.kb.searchPages).not.toHaveBeenCalled();
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

describe('a PR a reviewer closed', () => {
  const closedInLineage = (lineage: boolean) =>
    m.prisma.pullRequest.findFirst.mockImplementation(
      async (args: { where: { status?: string } }) =>
        args.where.status === 'OPEN' || !lineage ? null : { prNumber: 5, status: 'CLOSED' }
    );

  it('is not replaced when the same workflow pushes again', async () => {
    closedInLineage(true);
    await expect(createOrUpdatePullRequest(request, codeResult)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PR_CLOSED_BY_REVIEWER',
    });
    expect(m.createPr).not.toHaveBeenCalled();
    expect(m.prisma.pullRequest.create).not.toHaveBeenCalled();
    // The lookup is scoped to this execution's own ledger lineage.
    expect(m.prisma.pullRequest.findFirst.mock.calls.at(-1)?.[0].where).toMatchObject({
      workflow: { temporalWorkflowId: 'wf-own', workRequestId: 'wr-1' },
    });
  });

  it('does not stop a fresh run of the request, which opens its own PR', async () => {
    closedInLineage(false);
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.prisma.pullRequest.create).toHaveBeenCalled();
  });

  it('does not stop a workflow whose latest PR is merged or open elsewhere', async () => {
    m.prisma.pullRequest.findFirst.mockImplementation(
      async (args: { where: { status?: string } }) =>
        args.where.status === 'OPEN' ? null : { prNumber: 5, status: 'MERGED' }
    );
    await createOrUpdatePullRequest(request, codeResult);
    expect(m.prisma.pullRequest.create).toHaveBeenCalled();
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

describe('which PR is reused, and whose it becomes', () => {
  interface Where {
    repoId: string;
    status?: string;
    workflow: { temporalWorkflowId?: string; workRequestId: string };
  }
  interface Row {
    id: string;
    ledger: string;
    openedAt: Date;
    prNumber: number;
    repoId: string;
    status: string;
    workRequestId: string;
  }
  const day = (d: number) => new Date(Date.UTC(2026, 0, d));
  const row = (over: Partial<Row>): Row => ({
    id: 'x',
    ledger: 'wf-other',
    openedAt: day(1),
    prNumber: 1,
    repoId: 'repo-1',
    status: 'OPEN',
    workRequestId: 'wr-1',
    ...over,
  });
  // Fakes the table: honours every filter of the query and its orderBy.
  const table = (rows: Row[]) =>
    m.prisma.pullRequest.findFirst.mockImplementation(
      async (args: { where: Where; orderBy: Array<Record<string, 'asc' | 'desc'>> }) => {
        const { where } = args;
        const hits = rows.filter(
          (r) =>
            r.repoId === where.repoId &&
            r.workRequestId === where.workflow.workRequestId &&
            (!where.status || r.status === where.status) &&
            (!where.workflow.temporalWorkflowId || r.ledger === where.workflow.temporalWorkflowId)
        );
        for (const order of [...args.orderBy].reverse()) {
          const [key, dir] = Object.entries(order)[0] as [keyof Row, 'asc' | 'desc'];
          hits.sort(
            (x, y) => (dir === 'desc' ? -1 : 1) * (x[key] > y[key] ? 1 : x[key] < y[key] ? -1 : 0)
          );
        }
        return hits[0] ?? null;
      }
    );
  const run = () => createOrUpdatePullRequest(request, codeResult);

  beforeEach(() => {
    m.prisma.activeWorkflow.findFirst.mockImplementation(
      async (args: { where: { temporalWorkflowId?: string } }) =>
        args.where.temporalWorkflowId === 'wf-own' ? { id: 'own-row' } : { id: 'anchor-row' }
    );
  });

  it("prefers the open PR on this execution's own row over a newer one elsewhere", async () => {
    table([
      row({ id: 'a', ledger: 'wf-own', prNumber: 1 }),
      row({ id: 'b', openedAt: day(9), prNumber: 2 }),
    ]);
    await expect(run()).resolves.toMatchObject({ prNumber: 1 });
  });

  it('adopts the newest open PR of the request when none is on its own row, and re-links it', async () => {
    table([row({ id: 'a', prNumber: 1 }), row({ id: 'b', openedAt: day(9), prNumber: 2 })]);
    await expect(run()).resolves.toMatchObject({ prNumber: 2 });
    expect(m.prisma.pullRequest.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ workflowId: 'own-row' }),
      where: { id: 'b' },
    });
    expect(m.prisma.pullRequest.create).not.toHaveBeenCalled();
  });

  it('breaks an openedAt tie by id, newest first', async () => {
    table([row({ id: 'a', prNumber: 1 }), row({ id: 'b', prNumber: 2 })]);
    await expect(run()).resolves.toMatchObject({ prNumber: 2 });
  });

  it('ignores open PRs of another request or another repository', async () => {
    table([
      row({ id: 'a', prNumber: 1 }),
      row({ id: 'b', openedAt: day(9), prNumber: 2, workRequestId: 'wr-2' }),
      row({ id: 'c', openedAt: day(9), prNumber: 3, repoId: 'repo-2' }),
    ]);
    await expect(run()).resolves.toMatchObject({ prNumber: 1 });
  });

  it('keeps the link when it reuses its own row, and has nothing to re-link without one', async () => {
    table([row({ id: 'a', ledger: 'wf-own' })]);
    await run();
    expect(m.prisma.pullRequest.update.mock.calls[0]?.[0].data.workflowId).toBe('own-row');
    m.prisma.activeWorkflow.findFirst.mockImplementation(
      async (args: { where: { temporalWorkflowId?: string } }) =>
        args.where.temporalWorkflowId ? null : { id: 'anchor-row' }
    );
    table([row({ id: 'a' })]);
    await run();
    expect(m.prisma.pullRequest.update.mock.calls[1]?.[0].data.workflowId).toBeUndefined();
  });

  it('refuses to replace a PR the reviewer closed after this run adopted it', async () => {
    // Adoption re-linked the PR to this execution's row; the reviewer then closed it.
    table([row({ id: 'a', ledger: 'wf-own', status: 'CLOSED' })]);
    await expect(run()).rejects.toMatchObject({ type: 'PR_CLOSED_BY_REVIEWER' });
    expect(m.prisma.pullRequest.create).not.toHaveBeenCalled();
  });

  it("checks its own row's close before adopting another open PR", async () => {
    table([
      row({ id: 'a', ledger: 'wf-own', status: 'CLOSED' }),
      row({ id: 'b', openedAt: day(9), prNumber: 2 }),
    ]);
    await expect(run()).rejects.toMatchObject({ type: 'PR_CLOSED_BY_REVIEWER' });
    expect(m.prisma.pullRequest.update).not.toHaveBeenCalled();
  });

  it('adopts another open PR when its own latest one is merged', async () => {
    table([
      row({ id: 'a', ledger: 'wf-own', status: 'MERGED' }),
      row({ id: 'b', openedAt: day(9), prNumber: 2 }),
    ]);
    await expect(run()).resolves.toMatchObject({ prNumber: 2 });
  });

  it('opens a new PR when its own latest one is merged and none is open', async () => {
    table([row({ id: 'a', ledger: 'wf-own', status: 'MERGED' })]);
    await run();
    expect(m.prisma.pullRequest.create).toHaveBeenCalled();
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
