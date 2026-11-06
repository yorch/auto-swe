import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { AGENT_RUN_TEMPLATE_ORIGIN } from './agentRun.js';
import {
  loadReviewSource,
  prepareReviewLaunch,
  recordReviewLaunch,
  reviewFixRetryMetadata,
  reviewFixRetryState,
  reviewRunId,
  reviewRunMetadata,
} from './reviewLaunch.js';

const setting = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../config/index.js', () => ({ resolveSetting: setting }));
const SOURCE = '11111111-1111-4111-8111-111111111111';
const REPO = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const PRESET = '44444444-4444-4444-8444-444444444444';
const HEAD = 'a'.repeat(40);

describe('review fix retry eligibility', () => {
  const fixture = (reason = 'the fix workflow could not start') => {
    const step = {
      id: 'publish',
      outputs: { approved: false, fix: { reason, status: 'skipped' } },
    };
    const run = {
      reviewOfRunId: SOURCE,
      status: 'SUCCESS',
      steps: [step],
      template: { kind: 'review' },
      workRequest: {
        payload: {
          connectionId: REPO,
          onBlocking: 'fix',
          reviewOf: { mode: 'pr', prNumber: 7 },
          sourceRunId: SOURCE,
        },
      },
    };
    const fire = vi.fn().mockResolvedValue(null);
    const db = {
      automationFire: { findFirst: fire },
      workflowRun: { findUnique: vi.fn().mockResolvedValue(run) },
    };
    return { db: db as unknown as PrismaClient, fire, run, step };
  };
  it.each([
    'the fix workflow could not start',
    'repository is unavailable',
    'the organization is over its monthly budget',
    'a run started for pr-7 within the last 5 minutes',
    'an earlier run for pr-7 is still in progress',
    'the automation started 10 runs in the last 24 hours (cap 10)',
  ])('allows a transient decision: %s', async (reason) => {
    const { db, fire } = fixture(reason);
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: true });
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          connectionId: REPO,
          facts: { equals: PRESET, path: ['reviewRunId'] },
          source: 'github.pull_request.feedback',
        },
      })
    );
  });
  it.each([
    'round limit reached',
    'the reviewed head moved',
    'the branch is listed as never push',
    'the pull request is not open',
    'the pull request is from a fork',
    undefined,
  ])('refuses a permanent or empty decision: %s', async (reason) => {
    const { db, step } = fixture();
    Object.assign(step.outputs.fix, { reason });
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
  it.each(['RUNNING', 'FAILED'])('requires a successful review, not %s', async (status) => {
    const { db, run } = fixture();
    run.status = status;
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
  it('refuses approved results and decisions that started a fix', async () => {
    const { db, step, fire } = fixture();
    step.outputs.approved = true;
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
    step.outputs.approved = false;
    fire.mockResolvedValue({ id: 'fire', outcome: 'STARTED', reason: null });
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
  it.each(['started', 'unknown'])('requires a skipped summary, not %s', async (status) => {
    const { db, step } = fixture();
    step.outputs.fix.status = status;
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
  it.each(['FAILED_TO_START', 'SUPPRESSED_COOLDOWN', 'SUPPRESSED_DAILY_CAP'])(
    'allows a transient fire decision: %s',
    async (outcome) => {
      const { db, fire } = fixture();
      fire.mockResolvedValue({ id: 'fire', outcome, reason: 'the fix workflow could not start' });
      expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: true });
    }
  );
  it('gives concurrent submissions the same attempt, and a new decision a new attempt', async () => {
    const { db, step } = fixture();
    const first = await reviewFixRetryState(db, PRESET);
    expect(await reviewFixRetryState(db, PRESET)).toEqual(first);
    Object.assign(step.outputs.fix, { attemptId: 'previous-retry' });
    expect(await reviewFixRetryState(db, PRESET)).not.toEqual(first);
  });
  it.each(['pr', 'stored'])(
    'reports a durable queued %s retry until its decision resolves',
    async (mode) => {
      const { db, run, step } = fixture();
      if (mode === 'stored') {
        Object.assign(run.workRequest.payload, { reviewOf: { mode: 'stored' } });
        Object.assign(db, {
          workflowStep: {
            findFirst: vi.fn().mockResolvedValue({ outputs: { diffVerified: true } }),
          },
        });
      }
      expect(await reviewFixRetryMetadata(db, PRESET)).toEqual({ allowed: true });
      const state = await reviewFixRetryState(db, PRESET);
      if (!state.allowed) {
        throw new Error('Expected a retryable decision');
      }
      Object.assign(step.outputs, { fixRetry: { attemptId: state.attemptId, status: 'queued' } });
      expect(await reviewFixRetryMetadata(db, PRESET)).toEqual({
        allowed: false,
        status: 'queued',
      });
      expect(await reviewFixRetryState(db, PRESET)).toMatchObject({
        allowed: true,
        attemptId: state.attemptId,
      });
      Object.assign(step.outputs.fix, { attemptId: state.attemptId, status: 'skipped' });
      expect(await reviewFixRetryMetadata(db, PRESET)).toEqual({ allowed: true });
      step.outputs.fix.status = 'started';
      expect(await reviewFixRetryMetadata(db, PRESET)).toMatchObject({ allowed: false });
      expect(await reviewFixRetryMetadata(db, PRESET)).not.toHaveProperty('status');
    }
  );
  it('ignores a queued marker whose attempt has already resolved', async () => {
    const { db, step } = fixture();
    Object.assign(step.outputs, { fixRetry: { attemptId: 'older', status: 'queued' } });
    Object.assign(step.outputs.fix, { attemptId: 'older' });
    expect(await reviewFixRetryMetadata(db, PRESET)).toEqual({ allowed: true });
  });
  it.each(['STARTED', 'FAILED_TO_START', 'SUPPRESSED_COOLDOWN'])(
    'keeps the retry pending while its worker records a new %s fire',
    async (outcome) => {
      const { db, step, fire } = fixture();
      const state = await reviewFixRetryState(db, PRESET);
      if (!state.allowed) {
        throw new Error('Expected a retryable decision');
      }
      Object.assign(step.outputs, { fixRetry: { attemptId: state.attemptId, status: 'queued' } });
      fire.mockResolvedValue({
        id: 'retry-fire',
        outcome,
        reason: 'the fix workflow could not start',
      });
      expect(await reviewFixRetryMetadata(db, PRESET)).toEqual({
        allowed: false,
        status: 'queued',
      });
    }
  );
  it('does not let an older fire override a newer permanent skip', async () => {
    const { db, step, fire } = fixture();
    fire.mockResolvedValue({
      createdAt: new Date(0),
      id: 'old',
      outcome: 'FAILED_TO_START',
      reason: 'the fix workflow could not start',
    });
    Object.assign(step.outputs.fix, {
      decidedAt: new Date().toISOString(),
      reason: 'the reviewed head moved',
    });
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
  it('propagates database failures instead of allowing an unverified retry', async () => {
    const { db, fire } = fixture();
    fire.mockRejectedValue(new Error('offline'));
    await expect(reviewFixRetryState(db, PRESET)).rejects.toThrow('offline');
  });
  it('allows stored transient retries only after verified application and never reads PR fires', async () => {
    const { db, run, fire, step } = fixture('agent runs are at their concurrency limit');
    Object.assign(run.workRequest.payload, { reviewOf: { mode: 'stored' } });
    const loaded = vi.fn().mockResolvedValue({ outputs: { diffVerified: false } });
    Object.assign(db, { workflowStep: { findFirst: loaded } });
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
    loaded.mockResolvedValue({ outputs: { diffVerified: true } });
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: true });
    expect(fire).not.toHaveBeenCalled();
    step.outputs.fix.status = 'started';
    expect(await reviewFixRetryState(db, PRESET)).toMatchObject({ allowed: false });
  });
});

function fake() {
  const source = {
    connectionId: REPO,
    contextSnapshot: {
      context: { currentCodeResult: { baseBranch: 'main', branch: 'auto/change', headSha: HEAD } },
    },
    id: SOURCE,
    launchedById: 'launcher',
    reviewOfRun: null,
    reviewOfRunId: null,
    status: 'SUCCESS',
    steps: [],
    template: { kind: null, origin: null, teamId: null },
    workflowId: 'wf-source',
    workRequest: null,
  };
  const template = { activeVersion: 2, id: TEMPLATE, kind: 'review', status: 'ACTIVE' };
  const db = {
    $transaction: vi.fn(),
    activeWorkflow: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
    connection: {
      findUnique: vi.fn().mockResolvedValue({
        id: REPO,
        isActive: true,
        team: { orgId: 'org' },
        teamId: 'team',
        type: 'git_repo',
      }),
    },
    pullRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    reviewPreset: {
      findUnique: vi.fn().mockResolvedValue({
        enabled: true,
        id: PRESET,
        onBlocking: 'fix',
        systemPrompt: 'Instructions',
        templateId: TEMPLATE,
      }),
    },
    runInput: { create: vi.fn() },
    workflowRun: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(source),
    },
    workflowTemplate: { findUnique: vi.fn().mockResolvedValue(template) },
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return { db, prisma: db as unknown as PrismaClient, source, template };
}

beforeEach(() => setting.mockResolvedValue(true));

describe('review launch preparation', () => {
  it('accepts global and own-team presets but refuses another team at the shared launch boundary', async () => {
    const { db, prisma } = fake();
    const preset = await db.reviewPreset.findUnique();
    for (const teamId of [null, 'team']) {
      db.reviewPreset.findUnique.mockResolvedValue({ ...preset, teamId } as never);
      await expect(
        prepareReviewLaunch(prisma, { presetId: PRESET, sourceRunId: SOURCE })
      ).resolves.toBeDefined();
    }
    db.reviewPreset.findUnique.mockResolvedValue({ ...preset, teamId: 'other-team' } as never);
    await expect(
      prepareReviewLaunch(prisma, { presetId: PRESET, sourceRunId: SOURCE })
    ).rejects.toMatchObject({ code: 'REVIEW_PRESET_NOT_FOUND', status: 404 });
    db.workflowTemplate.findUnique.mockResolvedValue({
      activeVersion: 2,
      kind: 'review',
      status: 'ACTIVE',
      teamId: 'other-team',
    } as never);
    await expect(
      prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })
    ).rejects.toMatchObject({ code: 'REVIEW_TEMPLATE_INVALID' });
  });
  it('builds a scoped payload and ledger from a workflow CodeResult, and records ledger before a caller starts Temporal', async () => {
    const { db, prisma } = fake();
    const prepared = await prepareReviewLaunch(prisma, {
      launchedById: 'caller',
      nonceHex: 'deadbeef',
      presetId: PRESET,
      sourceRunId: SOURCE,
    });
    expect(prepared.workflowId).toBe('review-22222222-deadbeef');
    expect(prepared.payload).toMatchObject({
      connectionId: REPO,
      onBlocking: 'fix',
      presetId: PRESET,
      reviewOf: { baseBranch: 'main', branch: 'auto/change', headSha: HEAD, mode: 'branch' },
      sourceRunId: SOURCE,
      systemPrompt: 'Instructions',
    });
    expect(prepared.request.launchedById).toBe('caller');
    expect(prepared.runInput).toMatchObject({
      knowledgeSourceKind: 'REPOSITORY',
      knowledgeSourceRepoId: REPO,
      requestedById: 'caller',
    });
    await recordReviewLaunch(prisma, prepared);
    expect(db.runInput.create).toHaveBeenCalledOnce();
    expect(db.activeWorkflow.create).toHaveBeenCalledOnce();
    expect(prepared.runId).toBe(reviewRunId(prepared.workflowId));
    expect(prepared.runId).not.toBe(prepared.request.workRequestId);
  });

  it('prioritizes open PRs and supports legacy ledger linkage', async () => {
    const { db, prisma } = fake();
    db.pullRequest.findFirst.mockResolvedValue({ prNumber: 8, status: 'OPEN' });
    expect(
      (await prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })).payload
        .reviewOf
    ).toEqual({ mode: 'pr', prNumber: 8 });
    expect(db.pullRequest.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        OR: [{ runId: SOURCE }, { runId: null, workflow: { temporalWorkflowId: 'wf-source' } }],
      },
    });
  });

  it('supports deliver-none agent results in step outputs', async () => {
    const { db, prisma, source } = fake();
    db.workflowRun.findUnique.mockResolvedValue({
      ...source,
      contextSnapshot: null,
      steps: [{ outputs: { deliver: 'none', diff: 'stored bytes' } }],
      template: { kind: null, origin: AGENT_RUN_TEMPLATE_ORIGIN, teamId: null },
    });
    expect(
      (await prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })).payload
        .reviewOf
    ).toEqual({ mode: 'stored' });
  });

  it.each(['RUNNING', 'review', 'empty', 'missing'])('rejects %s source runs', async (kind) => {
    const { db, prisma, source } = fake();
    db.workflowRun.findUnique.mockResolvedValue(
      kind === 'missing'
        ? null
        : {
            ...source,
            ...(kind === 'RUNNING'
              ? { status: 'RUNNING' }
              : kind === 'review'
                ? { reviewOfRunId: SOURCE }
                : { contextSnapshot: null }),
          }
    );
    await expect(
      prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })
    ).rejects.toMatchObject({
      code:
        kind === 'missing'
          ? 'REVIEW_SOURCE_NOT_FOUND'
          : kind === 'RUNNING'
            ? 'REVIEW_SOURCE_NOT_FINISHED'
            : kind === 'review'
              ? 'REVIEW_SOURCE_IS_REVIEW'
              : 'REVIEW_NOTHING_TO_REVIEW',
    });
    expect(db.runInput.create).not.toHaveBeenCalled();
  });

  it('refuses disabled presets, non-review templates, disabled scope and invalid choices', async () => {
    const { db, prisma, template } = fake();
    db.reviewPreset.findUnique.mockResolvedValue({ enabled: false });
    await expect(
      prepareReviewLaunch(prisma, { presetId: PRESET, sourceRunId: SOURCE })
    ).rejects.toMatchObject({ code: 'REVIEW_PRESET_DISABLED' });
    db.workflowTemplate.findUnique.mockResolvedValue({ ...template, kind: null });
    await expect(
      prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })
    ).rejects.toMatchObject({ code: 'REVIEW_TEMPLATE_INVALID' });
    setting.mockResolvedValue(false);
    await expect(
      prepareReviewLaunch(prisma, { sourceRunId: SOURCE, templateId: TEMPLATE })
    ).rejects.toMatchObject({ code: 'REVIEW_DISABLED' });
    await expect(prepareReviewLaunch(prisma, { sourceRunId: SOURCE })).rejects.toMatchObject({
      code: 'REVIEW_TEMPLATE_INVALID',
    });
  });

  it('adopts an immutable recorded launch after a failed start acknowledgement', async () => {
    const { db, prisma } = fake();
    const prepared = await prepareReviewLaunch(prisma, {
      sourceRunId: SOURCE,
      templateId: TEMPLATE,
    });
    db.activeWorkflow.findUnique.mockResolvedValue({
      workRequest: {
        id: prepared.request.workRequestId,
        payload: { ...prepared.payload, reviewOf: { mode: 'pr', prNumber: 9 } },
        templateId: TEMPLATE,
        templateVersion: 1,
      },
    });
    expect(await recordReviewLaunch(prisma, prepared)).toMatchObject({
      request: { payload: { reviewOf: { mode: 'pr', prNumber: 9 } } },
      templateVersion: 1,
    });
    expect(db.runInput.create).not.toHaveBeenCalled();
  });

  it('reports linked review summaries and the reviewed source', async () => {
    const { db, prisma, source } = fake();
    db.workflowRun.findUnique.mockResolvedValue({
      ...source,
      reviewOfRun: { id: 'original', template: { name: 'Agent Run' } },
      reviewOfRunId: 'original',
    });
    db.workflowRun.findMany.mockResolvedValue([
      {
        id: 'review',
        reviewPreset: { name: 'Security' },
        startedAt: new Date('2026-01-01Z'),
        status: 'SUCCESS',
        steps: [{ outputs: { approved: false, worstSeverity: 'CRITICAL' } }],
        template: { name: 'code-review' },
        workflowId: 'review-wf',
      },
    ]);
    expect(await reviewRunMetadata(prisma, SOURCE)).toMatchObject({
      reason: 'REVIEW_SOURCE_IS_REVIEW',
      reviewable: false,
      reviewOf: { runId: 'original', templateName: 'Agent Run' },
      reviews: [{ approved: false, presetName: 'Security', worstSeverity: 'CRITICAL' }],
    });
  });

  it('uses a ledger repository when the source has no direct connection', async () => {
    const { db, prisma, source } = fake();
    db.workflowRun.findUnique.mockResolvedValue({ ...source, connectionId: null });
    db.activeWorkflow.findUnique.mockResolvedValue({ repoId: REPO });
    expect((await loadReviewSource(prisma, SOURCE)).connectionId).toBe(REPO);
  });
});
