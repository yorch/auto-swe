import { AGENT_RUN_TEMPLATE_ORIGIN } from '@auto-swe/shared/lib/agentRun';
import type { ReviewOf } from '@auto-swe/shared/lib/codeReview';
import type { AggregatedReviewResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from '../lib/agentTracer.js';
import type { ScmProvider } from '../lib/scm/index.js';
import type { QodoReviewResult } from './awaitQodoReview.js';
import {
  type LoadReviewDeps,
  loadChangeForReview,
  loadChangeForReviewWith,
  type PublishReviewDeps,
  publishReviewResultWith,
  requestReviewReevaluation,
} from './codeReview.js';
import type { Workspace } from './workspace.js';

const db = vi.hoisted(() => ({ source: vi.fn(), start: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findUnique: db.source } } }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { start: db.start } }),
}));

const REPO = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
it('starts a fresh reevaluation of the same PR with the publishing run identity', async () => {
  db.start.mockClear();
  const payload = {
    connectionId: REPO,
    onBlocking: 'report' as const,
    reviewOf: { mode: 'pr' as const, prNumber: 7 },
    sourceRunId: SOURCE,
  };
  await requestReviewReevaluation(payload, SOURCE);
  await requestReviewReevaluation(payload, SOURCE);
  expect(db.start).toHaveBeenCalledWith(
    'prEvaluationWorkflow',
    expect.objectContaining({
      args: [{ connectionId: REPO, prNumber: 7, reviewRunId: SOURCE, trigger: 'review_run' }],
      taskQueue: 'engineering-workflow',
    })
  );
  const ids = db.start.mock.calls.map((call) => (call[1] as { workflowId: string }).workflowId);
  expect(new Set(ids).size).toBe(2);
});
const repo = {
  defaultBranch: 'main',
  detectedStack: null,
  executorImage: null,
  githubApiUrl: null,
  githubUrl: null,
  id: REPO,
  installation: null,
  organizationName: 'org',
  repoName: 'repo',
  teamId: null,
  type: 'git_repo',
} as unknown as Awaited<ReturnType<LoadReviewDeps['loadRepo']>>;

function request(
  reviewOf: ReviewOf = { mode: 'pr', prNumber: 7 },
  onBlocking = 'report'
): RepoWorkRequest {
  return {
    description: 'Review',
    payload: { connectionId: REPO, onBlocking, reviewOf, sourceRunId: SOURCE },
    repoId: REPO,
    workRequestId: SOURCE,
  } as RepoWorkRequest;
}

function fixture() {
  const exec = vi.fn(async (cmd: string) =>
    cmd.includes('merge-base') ? BASE : cmd.includes(' diff ') ? DIFF : HEAD
  );
  const destroy = vi.fn(async () => undefined);
  const gitAuthed = vi.fn(async () => '');
  const workspace = { destroy, exec, gitAuthed } as unknown as Workspace;
  const comment = vi.fn(
    async (_ref: unknown, _number: number, _marker: string, _body: string) => undefined
  );
  const pr = vi.fn(async () => ({
    baseRef: 'main',
    headRef: 'auto/source',
    headRepositoryFullName: 'org/repo',
    headSha: HEAD,
    htmlUrl: 'https://github.com/org/repo/pull/7',
    merged: false,
    number: 7,
    state: 'open' as 'open' | 'closed',
  }));
  const scm = {
    cloneCredentials: vi.fn(async () => ({ authedCloneUrl: 'https://host/org/repo' })),
    pullRequestInfo: pr,
    upsertMarkedComment: comment,
  } as unknown as ScmProvider;
  const change: LoadReviewDeps = {
    createWorkspace: vi.fn(async () => workspace),
    loadRepo: vi.fn(async () => repo),
    loadStored: vi.fn(async () => DIFF),
    scm: () => scm,
  };
  const publish: PublishReviewDeps = {
    loadRepo: change.loadRepo,
    reevaluate: vi.fn(async () => undefined),
    requestReviewFix: vi.fn(async () => undefined),
    runId: vi.fn(async () => SOURCE),
    scm: () => scm,
    webUrl: () => 'https://web.example/',
  };
  const event = vi.fn();
  const tracer = { addActivityEvent: event } as unknown as AgentTracer;
  return { change, comment, destroy, event, exec, gitAuthed, pr, publish, tracer };
}

function verdict(approved = true): AggregatedReviewResult {
  return {
    approved,
    codeResult: {
      branch: 'auto/source',
      diff: DIFF,
      filesChanged: [],
      headSha: HEAD,
      implementationNotes: '',
      testResults: {
        duration_ms: 0,
        failing: 0,
        passed: false,
        passing: 0,
        stdout: 'Not run',
        total: 0,
      },
    },
    verdicts: [
      {
        approved,
        findings: approved
          ? []
          : [
              {
                category: 'Security',
                description: '<script> @team https://bad.example',
                file: 'a.ts',
                suggestedFix: 'Fix it',
              },
            ],
        reviewer: 'SECURITY',
        severity: approved ? 'PASS' : 'CRITICAL',
      },
    ],
  };
}

describe('loadChangeForReview', () => {
  beforeEach(() => db.source.mockReset());

  it('pins a host PR head, verifies it, fetches the base and produces a hardened merge-base diff', async () => {
    const f = fixture();
    const output = await loadChangeForReviewWith(request(), f.change);
    expect(output).toMatchObject({
      baseSha: BASE,
      diff: DIFF,
      diffVerified: true,
      headSha: HEAD,
      prUrl: 'https://github.com/org/repo/pull/7',
      testResults: { passed: false, stdout: 'Tests not run (review only).', total: 0 },
    });
    expect(output.filesChanged).toHaveLength(1);
    expect(f.change.createWorkspace).toHaveBeenCalledWith(
      'https://host/org/repo',
      'auto/source',
      'main',
      undefined,
      HEAD,
      false,
      { detectedStack: null, teamId: null }
    );
    expect(
      f.exec.mock.calls.some(
        ([cmd]) =>
          cmd.includes('GIT_NO_REPLACE_OBJECTS=1') &&
          cmd.includes('--text --no-textconv --no-ext-diff --no-color --no-renames')
      )
    ).toBe(true);
    expect(f.gitAuthed).toHaveBeenCalledWith(
      "fetch origin '+refs/heads/main:refs/remotes/origin/main'"
    );
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it('checks out the existing branch and fails rather than reviewing a moved head', async () => {
    const f = fixture();
    f.exec.mockResolvedValueOnce('c'.repeat(40));
    await expect(
      loadChangeForReviewWith(
        request({ branch: 'auto/source', headSha: HEAD, mode: 'branch' }),
        f.change
      )
    ).rejects.toMatchObject({ type: 'REVIEW_HEAD_CHANGED' });
    expect(f.change.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      'auto/source',
      'main',
      undefined,
      undefined,
      true,
      expect.any(Object)
    );
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it('reviews a matching branch and permits an empty diff', async () => {
    const f = fixture();
    f.exec.mockImplementation(async (cmd) =>
      cmd.includes('merge-base') ? BASE : cmd.includes(' diff ') ? '' : HEAD
    );
    const output = await loadChangeForReviewWith(
      request({ baseBranch: 'release/1', branch: 'auto/source', headSha: HEAD, mode: 'branch' }),
      f.change
    );
    expect(output.filesChanged).toEqual([]);
    expect(output.baseBranch).toBe('release/1');
  });

  it.each(['closed', 'fork', 'deleted fork'])('refuses a %s PR before cloning', async (reason) => {
    const f = fixture();
    const info = await f.pr();
    f.pr.mockResolvedValue({
      ...info,
      ...(reason === 'closed'
        ? { state: 'closed' as const }
        : { headRepositoryFullName: reason === 'fork' ? 'elsewhere/repo' : '' }),
    });
    await expect(loadChangeForReviewWith(request(), f.change)).rejects.toMatchObject({
      type: reason === 'closed' ? 'REVIEW_PR_CLOSED' : 'REVIEW_PR_FORK',
    });
    expect(f.change.createWorkspace).not.toHaveBeenCalled();
  });

  it('also verifies the pinned PR checkout', async () => {
    const f = fixture();
    f.exec.mockResolvedValueOnce(BASE);
    await expect(loadChangeForReviewWith(request(), f.change)).rejects.toMatchObject({
      type: 'REVIEW_HEAD_CHANGED',
    });
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it.each(['oversized', 'diff error', 'history error'])(
    'destroys the workspace on %s',
    async (kind) => {
      const f = fixture();
      if (kind === 'history error') {
        f.gitAuthed.mockRejectedValueOnce(new Error('fetch failed'));
        f.exec.mockResolvedValueOnce(HEAD).mockResolvedValueOnce('true');
      } else {
        f.exec.mockImplementation(async (cmd) => {
          if (cmd.includes('merge-base')) {
            return BASE;
          }
          if (cmd.includes(' diff ')) {
            if (kind === 'diff error') {
              throw new Error('git failed');
            }
            return 'x'.repeat(300_001);
          }
          return HEAD;
        });
      }
      await expect(loadChangeForReviewWith(request(), f.change)).rejects.toThrow();
      expect(f.destroy).toHaveBeenCalledOnce();
    }
  );

  it('loads unverified stored bytes without cloning or exposing a usable head SHA', async () => {
    const f = fixture();
    const output = await loadChangeForReviewWith(request({ mode: 'stored' }), f.change);
    expect(output).toMatchObject({
      diff: DIFF,
      diffVerified: false,
      headSha: '',
      implementationNotes: expect.stringContaining('UNVERIFIED'),
    });
    expect(f.change.createWorkspace).not.toHaveBeenCalled();
    expect(f.change.loadStored).toHaveBeenCalledWith(SOURCE, REPO);
    f.change.loadStored = async () => 'x'.repeat(300_001);
    await expect(
      loadChangeForReviewWith(request({ mode: 'stored' }), f.change)
    ).rejects.toMatchObject({ type: 'REVIEW_DIFF_TOO_LARGE' });
  });

  it('reads the persisted source agent result and rejects truncated, empty and wrong-repository sources', async () => {
    const source = {
      connectionId: REPO,
      contextSnapshot: { result: { deliver: 'none', diff: DIFF } },
      endedAt: new Date(),
      reviewOfRunId: null,
      steps: [],
      template: { origin: AGENT_RUN_TEMPLATE_ORIGIN, teamId: null },
    };
    db.source.mockResolvedValue(source);
    expect((await loadChangeForReview(request({ mode: 'stored' }))).diff).toBe(DIFF);
    db.source.mockResolvedValue({
      ...source,
      contextSnapshot: { result: { deliver: 'none', diff: DIFF, diffTruncated: true } },
    });
    await expect(loadChangeForReview(request({ mode: 'stored' }))).rejects.toMatchObject({
      type: 'REVIEW_DIFF_TOO_LARGE',
    });
    db.source.mockResolvedValue({
      ...source,
      contextSnapshot: { result: { deliver: 'none', diff: '' } },
    });
    await expect(loadChangeForReview(request({ mode: 'stored' }))).rejects.toMatchObject({
      type: 'REVIEW_NOTHING_TO_REVIEW',
    });
    db.source.mockResolvedValue({ ...source, connectionId: SOURCE });
    await expect(loadChangeForReview(request({ mode: 'stored' }))).rejects.toMatchObject({
      type: 'REVIEW_NOTHING_TO_REVIEW',
    });
  });

  it('validates payloads and connection identity before any side effect', async () => {
    const f = fixture();
    await expect(
      loadChangeForReviewWith({ ...request(), payload: {} }, f.change)
    ).rejects.toMatchObject({ type: 'REVIEW_INVALID_PAYLOAD' });
    await expect(
      loadChangeForReviewWith({ ...request(), repoId: SOURCE }, f.change)
    ).rejects.toMatchObject({ type: 'REVIEW_CONNECTION_MISMATCH' });
    expect(f.change.loadRepo).not.toHaveBeenCalled();
  });
});

describe('publishReviewResult', () => {
  it('publishes an empty approved summary with the marked comment and configured run URL', async () => {
    const f = fixture();
    expect(
      await publishReviewResultWith({ request: request(), review: verdict() }, f.publish, f.tracer)
    ).toEqual({ approved: true, findingCount: 0, findings: [], worstSeverity: 'PASS' });
    expect(f.comment).toHaveBeenCalledWith(
      expect.any(Object),
      7,
      `<!-- auto-swe:code-review:${SOURCE} -->`,
      expect.stringContaining(`https://web.example/runs/${SOURCE}`)
    );
    expect(f.publish.reevaluate).toHaveBeenCalledOnce();
    expect(f.publish.requestReviewFix).not.toHaveBeenCalled();
  });

  it('sanitizes model text, bounds findings and preserves the full finding count', async () => {
    const f = fixture();
    const review = verdict(false);
    review.verdicts[0].findings = Array.from({ length: 80 }, () => ({
      ...review.verdicts[0].findings[0],
      suggestedFix: '*'.repeat(3000),
    }));
    const summary = await publishReviewResultWith(
      { request: request(), review },
      f.publish,
      f.tracer
    );
    expect(summary).toMatchObject({ approved: false, findingCount: 80, worstSeverity: 'CRITICAL' });
    expect(summary.findings).toHaveLength(20);
    const body = f.comment.mock.calls[0]?.[3] as string;
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('@team');
    expect(body.length).toBeLessThan(60_000);
  });

  it('includes human notes and treats only a request for changes as rejection', async () => {
    const f = fixture();
    const human = { decision: 'approve', feedback: 'Useful note @team' };
    expect(
      await publishReviewResultWith({ human, request: request() }, f.publish, f.tracer)
    ).toMatchObject({ approved: true, humanNote: human.feedback });
    expect(f.comment.mock.calls[0]?.[3]).toContain('Reviewer note:');
    expect(
      await publishReviewResultWith(
        { human: { ...human, decision: 'request-changes' }, request: request() },
        f.publish,
        f.tracer
      )
    ).toMatchObject({ approved: false, worstSeverity: 'WARNING' });
  });

  it.each([true, false])(
    'counts Qodo blocking findings only at the reviewed head (matching = %s)',
    async (matching) => {
      const f = fixture();
      const qodo = {
        counts: { actionRequired: 2, informational: 0, open: 2, remediationRecommended: 0 },
        findings: [],
        headMatches: true,
        reviewedHeadSha: matching ? HEAD : BASE,
        status: 'reviewed',
      } as unknown as QodoReviewResult;
      expect(
        await publishReviewResultWith(
          { qodo, request: request(), review: verdict() },
          f.publish,
          f.tracer
        )
      ).toMatchObject({
        approved: !matching,
        findingCount: matching ? 2 : 0,
        worstSeverity: matching ? 'CRITICAL' : 'PASS',
      });
    }
  );

  it('records re-evaluation failures without failing the review', async () => {
    const f = fixture();
    f.publish.reevaluate = vi.fn(async () => {
      throw new Error('Temporal unavailable');
    });
    await expect(
      publishReviewResultWith({ request: request(), review: verdict() }, f.publish, f.tracer)
    ).resolves.toMatchObject({ approved: true });
    expect(f.event).toHaveBeenCalledWith({
      name: 'code_review.reevaluation_failed',
      outputJson: { runId: SOURCE },
    });
  });

  it.each([
    ['fix', false, true],
    ['report', false, false],
    ['fix', true, false],
  ] as const)(
    'calls the fix hook only for blocking fix policy (%s, %s)',
    async (policy, approved, called) => {
      const f = fixture();
      await publishReviewResultWith(
        { request: request({ mode: 'stored' }, policy), review: verdict(approved) },
        f.publish,
        f.tracer
      );
      expect(f.publish.requestReviewFix).toHaveBeenCalledTimes(called ? 1 : 0);
      expect(f.comment).not.toHaveBeenCalled();
      expect(f.publish.reevaluate).not.toHaveBeenCalled();
    }
  );

  it('refuses missing results or run identity and does not hide comment errors', async () => {
    const f = fixture();
    await expect(
      publishReviewResultWith({ request: request() }, f.publish, f.tracer)
    ).rejects.toMatchObject({ type: 'REVIEW_RESULT_MISSING' });
    f.comment.mockRejectedValueOnce(new Error('host unavailable'));
    await expect(
      publishReviewResultWith({ request: request(), review: verdict() }, f.publish, f.tracer)
    ).rejects.toThrow('host unavailable');
    f.publish.runId = async () => undefined;
    await expect(
      publishReviewResultWith({ request: request(), review: verdict() }, f.publish, f.tracer)
    ).rejects.toMatchObject({ type: 'REVIEW_RUN_MISSING' });
  });
});
