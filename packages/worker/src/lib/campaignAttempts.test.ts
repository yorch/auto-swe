import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  activeWorkflow: { findMany: vi.fn() },
  campaignAttempt: { findFirst: vi.fn(), updateMany: vi.fn() },
  pullRequest: { findFirst: vi.fn() },
  workflowRun: { findUnique: vi.fn() },
}));
const temporal = vi.hoisted(() => ({ getHandle: vi.fn(), signal: vi.fn() }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('./temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { getHandle: temporal.getHandle } }),
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import {
  ATTEMPT_NEVER_STARTED_MS,
  ATTEMPT_RUN_GRACE_MS,
  attemptOutcomeFromRun,
  completeCampaignAttemptForRun,
  markCampaignAttemptRunStarted,
  onCampaignRunFinalized,
  reconcileCampaignAttempt,
} from './campaignAttempts.js';

const run = (over: Record<string, unknown> = {}) => ({
  contextSnapshot: {},
  endedAt: new Date(1000),
  id: 'run-1',
  status: 'SUCCESS',
  steps: [],
  workflowId: 'campaign-c1-w1',
  ...over,
});

const snapshot = (result: Record<string, unknown>) => ({ result });

beforeEach(() => {
  vi.resetAllMocks();
  db.campaignAttempt.updateMany.mockResolvedValue({ count: 1 });
  db.pullRequest.findFirst.mockResolvedValue(null);
  temporal.getHandle.mockReturnValue({ signal: temporal.signal });
  temporal.signal.mockResolvedValue(undefined);
});

describe('attemptOutcomeFromRun', () => {
  it('maps a run that opened a pull request to PR_OPENED with its path and verification', async () => {
    const r = await attemptOutcomeFromRun(
      run({
        contextSnapshot: snapshot({
          path: 'RECIPE',
          prUrl: 'https://github.com/acme/api/pull/9',
          verification: 'PASSED',
        }),
      }) as never
    );
    expect(r).toEqual({
      failureReason: null,
      outcome: 'PR_OPENED',
      path: 'RECIPE',
      verification: 'PASSED',
    });
  });

  it('maps a successful run that changed nothing to NO_CHANGE', async () => {
    const r = await attemptOutcomeFromRun(
      run({
        contextSnapshot: snapshot({ changed: false, path: 'NONE', verification: 'NOT_RUN' }),
      }) as never
    );
    expect(r).toMatchObject({ failureReason: null, outcome: 'NO_CHANGE', path: 'NONE' });
  });

  it('counts a pull request row as an opened pull request when the result carries no URL', async () => {
    db.pullRequest.findFirst.mockResolvedValue({ id: 'pr-1' });
    const r = await attemptOutcomeFromRun(run({ contextSnapshot: snapshot({}) }) as never);
    expect(r.outcome).toBe('PR_OPENED');
    expect(db.pullRequest.findFirst.mock.calls[0]?.[0].where).toEqual({ runId: 'run-1' });
  });

  it('maps a success with nothing to show for it, a failure and a timeout to FAILED with a reason', async () => {
    const none = await attemptOutcomeFromRun(run({ contextSnapshot: snapshot({}) }) as never);
    expect(none).toMatchObject({
      failureReason: 'the run finished without opening a pull request',
      outcome: 'FAILED',
    });
    const failed = await attemptOutcomeFromRun(
      run({
        contextSnapshot: snapshot({ skippedReason: 'did not pass the original tests' }),
        status: 'FAILED',
      }) as never
    );
    expect(failed).toMatchObject({
      failureReason: 'did not pass the original tests',
      outcome: 'FAILED',
    });
    const timedOut = await attemptOutcomeFromRun(
      run({ contextSnapshot: snapshot({}), status: 'TIMED_OUT' }) as never
    );
    expect(timedOut).toMatchObject({ failureReason: 'timed out', outcome: 'FAILED' });
  });

  it('falls back to the last step’s error, masked, for a failure with no reason', async () => {
    const r = await attemptOutcomeFromRun(
      run({
        contextSnapshot: null,
        status: 'FAILED',
        steps: [{ error: `push failed with ghp_${'a'.repeat(36)}` }],
      }) as never
    );
    expect(r.outcome).toBe('FAILED');
    expect(r.failureReason).not.toContain('ghp_aaaa');
  });

  it('maps a cancelled run to CANCELLED', async () => {
    const r = await attemptOutcomeFromRun(run({ status: 'CANCELLED' }) as never);
    expect(r).toMatchObject({ failureReason: null, outcome: 'CANCELLED' });
  });
});

describe('markCampaignAttemptRunStarted', () => {
  it('names the run on the attempt that started it, once', async () => {
    await expect(
      markCampaignAttemptRunStarted({ runId: 'run-1', workflowId: 'campaign-c1-w1' })
    ).resolves.toBe(true);
    expect(db.campaignAttempt.updateMany).toHaveBeenCalledWith({
      data: { runId: 'run-1' },
      where: { childWorkflowId: 'campaign-c1-w1', runId: null },
    });
    db.campaignAttempt.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      markCampaignAttemptRunStarted({ runId: 'run-1', workflowId: 'other' })
    ).resolves.toBe(false);
  });
});

describe('completeCampaignAttemptForRun', () => {
  const attemptRow = (kind = 'RECONCILER') => ({
    id: 'att-1',
    n: 2,
    target: { campaign: { temporalWorkflowId: 'campaign-c1', workflowKind: kind }, id: 'tg-1' },
  });

  it('records the outcome of the attempt whose run ended, conditional on no outcome yet', async () => {
    db.workflowRun.findUnique.mockResolvedValue(
      run({ contextSnapshot: snapshot({ changed: false }) })
    );
    db.campaignAttempt.findFirst.mockResolvedValue(attemptRow());
    const done = await completeCampaignAttemptForRun('run-1');
    expect(done).toEqual({
      attemptId: 'att-1',
      campaignWorkflowId: 'campaign-c1',
      n: 2,
      reconciler: true,
      runId: 'run-1',
      targetId: 'tg-1',
    });
    const find = db.campaignAttempt.findFirst.mock.calls[0]?.[0];
    expect(find.where).toEqual({
      OR: [{ runId: 'run-1' }, { childWorkflowId: 'campaign-c1-w1' }],
      outcome: null,
    });
    expect(db.campaignAttempt.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: 'NO_CHANGE', runId: 'run-1' }),
      where: { id: 'att-1', outcome: null },
    });
  });

  it('is a no-op for a run with no attempt, a run still going, and a duplicate delivery', async () => {
    db.workflowRun.findUnique.mockResolvedValue(run({ endedAt: null }));
    await expect(completeCampaignAttemptForRun('run-1')).resolves.toBeNull();
    db.workflowRun.findUnique.mockResolvedValue(run());
    db.campaignAttempt.findFirst.mockResolvedValue(null);
    await expect(completeCampaignAttemptForRun('run-1')).resolves.toBeNull();
    db.campaignAttempt.findFirst.mockResolvedValue(attemptRow());
    db.campaignAttempt.updateMany.mockResolvedValue({ count: 0 });
    await expect(completeCampaignAttemptForRun('run-1')).resolves.toBeNull();
  });
});

describe('onCampaignRunFinalized', () => {
  it('tells a reconciler campaign’s workflow that the attempt finished', async () => {
    db.workflowRun.findUnique.mockResolvedValue(run());
    db.campaignAttempt.findFirst.mockResolvedValue({
      id: 'att-1',
      n: 2,
      target: {
        campaign: { temporalWorkflowId: 'campaign-c1', workflowKind: 'RECONCILER' },
        id: 'tg-1',
      },
    });
    await onCampaignRunFinalized('run-1');
    expect(temporal.getHandle).toHaveBeenCalledWith('campaign-c1');
    expect(temporal.signal).toHaveBeenCalledWith('campaignAttemptFinished', {
      attemptN: 2,
      runId: 'run-1',
      targetId: 'tg-1',
    });
  });

  it('records a legacy campaign’s attempt but sends it no signal', async () => {
    db.workflowRun.findUnique.mockResolvedValue(run());
    db.campaignAttempt.findFirst.mockResolvedValue({
      id: 'att-1',
      n: 1,
      target: {
        campaign: { temporalWorkflowId: 'campaign-c1', workflowKind: 'LEGACY' },
        id: 'tg-1',
      },
    });
    await onCampaignRunFinalized('run-1');
    expect(db.campaignAttempt.updateMany).toHaveBeenCalled();
    expect(temporal.signal).not.toHaveBeenCalled();
  });

  it('never throws: a lost signal, or a database that is down, is left for the reconciler', async () => {
    db.workflowRun.findUnique.mockResolvedValue(run());
    db.campaignAttempt.findFirst.mockResolvedValue({
      id: 'att-1',
      n: 1,
      target: {
        campaign: { temporalWorkflowId: 'campaign-c1', workflowKind: 'RECONCILER' },
        id: 'tg-1',
      },
    });
    temporal.signal.mockRejectedValue(new Error('workflow not found'));
    await expect(onCampaignRunFinalized('run-1')).resolves.toBeUndefined();
    db.workflowRun.findUnique.mockRejectedValue(new Error('database down'));
    await expect(onCampaignRunFinalized('run-1')).resolves.toBeUndefined();
  });
});

describe('reconcileCampaignAttempt', () => {
  const attempt = (over: Record<string, unknown> = {}) => ({
    campaignWorkflowId: 'campaign-c1',
    childWorkflowId: 'campaign-c1-w1',
    id: 'att-1',
    n: 1,
    reconciler: true,
    runId: null,
    startedAt: new Date(0),
    targetId: 'tg-1',
    ...over,
  });

  it('completes an attempt whose run ended unrecorded, and names the run on it', async () => {
    db.workflowRun.findUnique.mockResolvedValue(
      run({ contextSnapshot: snapshot({ changed: false }) })
    );
    const done = await reconcileCampaignAttempt(attempt(), 5000);
    expect(done).toMatchObject({ attemptId: 'att-1', runId: 'run-1' });
    expect(db.workflowRun.findUnique.mock.calls[0]?.[0].where).toEqual({
      workflowId: 'campaign-c1-w1',
    });
    expect(db.campaignAttempt.updateMany.mock.calls[0]?.[0]).toEqual({
      data: { runId: 'run-1' },
      where: { id: 'att-1', runId: null },
    });
  });

  it('leaves an attempt whose run is still going', async () => {
    db.workflowRun.findUnique.mockResolvedValue(run({ endedAt: null }));
    await expect(reconcileCampaignAttempt(attempt({ runId: 'run-1' }), 5000)).resolves.toBeNull();
    expect(db.workflowRun.findUnique.mock.calls[0]?.[0].where).toEqual({ id: 'run-1' });
  });

  it('gives a run that has not appeared yet time to', async () => {
    db.workflowRun.findUnique.mockResolvedValue(null);
    await expect(
      reconcileCampaignAttempt(attempt({ startedAt: new Date(1000) }), 1000 + 1000)
    ).resolves.toBeNull();
    expect(db.activeWorkflow.findMany).not.toHaveBeenCalled();
  });

  it('fails an attempt whose run never appeared once its workflow ledger is dead', async () => {
    db.workflowRun.findUnique.mockResolvedValue(null);
    db.activeWorkflow.findMany.mockResolvedValue([{ currentStatus: 'FAILED' }]);
    const done = await reconcileCampaignAttempt(attempt(), ATTEMPT_NEVER_STARTED_MS + 1);
    expect(done).toMatchObject({ attemptId: 'att-1' });
    expect(db.campaignAttempt.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { failureReason: 'the run ended without starting', outcome: 'FAILED' },
      where: { id: 'att-1', outcome: null },
    });
  });

  it('does not fail an attempt whose workflow is still alive, or has no ledger row', async () => {
    db.workflowRun.findUnique.mockResolvedValue(null);
    db.activeWorkflow.findMany.mockResolvedValue([{ currentStatus: 'IMPLEMENTING' }]);
    await expect(
      reconcileCampaignAttempt(attempt(), ATTEMPT_NEVER_STARTED_MS + 1)
    ).resolves.toBeNull();
    db.activeWorkflow.findMany.mockResolvedValue([]);
    await expect(
      reconcileCampaignAttempt(attempt(), ATTEMPT_NEVER_STARTED_MS + 1)
    ).resolves.toBeNull();
  });

  describe('a run row that never appeared and a ledger that cannot say', () => {
    const settled = (status: string) => ({
      describe: vi.fn().mockResolvedValue({ status: { name: status } }),
    });

    beforeEach(() => {
      db.workflowRun.findUnique.mockResolvedValue(null);
      db.activeWorkflow.findMany.mockResolvedValue([]);
    });

    it('fails the attempt once Temporal no longer knows its child, so it stops holding a slot', async () => {
      temporal.getHandle.mockReturnValue({
        describe: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('nf'), { name: 'WorkflowNotFoundError' })),
      });
      const done = await reconcileCampaignAttempt(attempt(), ATTEMPT_RUN_GRACE_MS + 1);
      expect(done).toMatchObject({ attemptId: 'att-1' });
      expect(db.campaignAttempt.updateMany.mock.calls[0]?.[0]).toMatchObject({
        data: { failureReason: 'the run never started', outcome: 'FAILED' },
        where: { id: 'att-1', outcome: null },
      });
    });

    it('fails it when the child closed without creating a run, even with a ledger still saying it works', async () => {
      db.activeWorkflow.findMany.mockResolvedValue([{ currentStatus: 'IMPLEMENTING' }]);
      temporal.getHandle.mockReturnValue(settled('FAILED'));
      await expect(
        reconcileCampaignAttempt(attempt(), ATTEMPT_RUN_GRACE_MS + 1)
      ).resolves.toMatchObject({ attemptId: 'att-1' });
    });

    it('leaves it while the child is running, within the grace, or when Temporal cannot be asked', async () => {
      temporal.getHandle.mockReturnValue(settled('RUNNING'));
      await expect(
        reconcileCampaignAttempt(attempt(), ATTEMPT_RUN_GRACE_MS + 1)
      ).resolves.toBeNull();
      temporal.getHandle.mockReturnValue(settled('FAILED'));
      await expect(
        reconcileCampaignAttempt(attempt(), ATTEMPT_RUN_GRACE_MS - 1)
      ).resolves.toBeNull();
      temporal.getHandle.mockReturnValue({
        describe: vi.fn().mockRejectedValue(new Error('unavailable')),
      });
      await expect(
        reconcileCampaignAttempt(attempt(), ATTEMPT_RUN_GRACE_MS + 1)
      ).resolves.toBeNull();
      expect(db.campaignAttempt.updateMany).not.toHaveBeenCalled();
    });
  });

  it('never throws', async () => {
    db.workflowRun.findUnique.mockRejectedValue(new Error('database down'));
    await expect(reconcileCampaignAttempt(attempt(), 5000)).resolves.toBeNull();
  });
});
