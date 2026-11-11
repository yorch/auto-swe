import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  campaign: { update: vi.fn() },
  campaignTarget: { updateMany: vi.fn() },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));

import {
  finalizeCampaign,
  recordCampaignState,
  recordCampaignTargetResult,
  recordCampaignTargetStarted,
} from './campaign.js';

const success = (extra: Record<string, unknown> = {}) =>
  ({
    lessonsGenerated: [],
    status: 'SUCCESS',
    totalCIRetries: 0,
    totalReviewRetries: 0,
    ...extra,
  }) as never;
const failed = (reason?: string) =>
  ({
    lessonsGenerated: [],
    status: 'FAILED',
    totalCIRetries: 0,
    totalReviewRetries: 0,
    ...(reason ? { skippedReason: reason } : {}),
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  db.campaignTarget.updateMany.mockResolvedValue({ count: 1 });
  db.campaign.update.mockResolvedValue({});
});

describe('recordCampaignTargetStarted', () => {
  it('moves only a PENDING target of this team to RUNNING', async () => {
    await recordCampaignTargetStarted({
      campaignId: 'c1',
      childWorkflowId: 'campaign-c1-r1',
      connectionId: 'r1',
      teamId: 't1',
    });
    const arg = db.campaignTarget.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      campaignId: 'c1',
      connectionId: 'r1',
      state: 'PENDING',
      teamId: 't1',
    });
    expect(arg.data).toMatchObject({ childWorkflowId: 'campaign-c1-r1', state: 'RUNNING' });
  });

  it('treats a count of 0 (a retry, or an already finished target) as a no-op', async () => {
    db.campaignTarget.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      recordCampaignTargetStarted({
        campaignId: 'c1',
        childWorkflowId: 'w',
        connectionId: 'r1',
        teamId: 't1',
      })
    ).resolves.toBeUndefined();
  });
});

describe('recordCampaignTargetResult', () => {
  const base = { campaignId: 'c1', cancelled: false, connectionId: 'r1', teamId: 't1' };

  it('writes only over a PENDING or RUNNING target, scoped by team', async () => {
    await recordCampaignTargetResult({
      ...base,
      result: success({ changed: true, prUrl: 'https://github.com/a/b/pull/12' }),
    });
    const arg = db.campaignTarget.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      campaignId: 'c1',
      connectionId: 'r1',
      state: { in: ['PENDING', 'RUNNING'] },
      teamId: 't1',
    });
    expect(arg.data).toMatchObject({
      prNumber: 12,
      prUrl: 'https://github.com/a/b/pull/12',
      state: 'PR_OPENED',
    });
    expect(arg.data.finishedAt).toBeInstanceOf(Date);
  });

  it('records a not-affected child', async () => {
    await recordCampaignTargetResult({
      ...base,
      result: success({ changed: false, path: 'NONE', verification: 'NOT_RUN' }),
    });
    expect(db.campaignTarget.updateMany.mock.calls[0][0].data).toMatchObject({
      path: 'NONE',
      state: 'NOT_AFFECTED',
      verification: 'NOT_RUN',
    });
  });

  it('records a rejected child as FAILED with a masked, bounded reason', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    await recordCampaignTargetResult({
      ...base,
      result: failed(`child failed to start or errored: boom ${token} ${'x'.repeat(900)}`),
    });
    const data = db.campaignTarget.updateMany.mock.calls[0][0].data;
    expect(data.state).toBe('FAILED');
    expect(data.failureReason).not.toContain(token);
    expect(data.failureReason.length).toBeLessThanOrEqual(500);
  });

  it('records CANCELLED for an unfinished child after a cancel, but keeps a finished outcome', async () => {
    await recordCampaignTargetResult({
      ...base,
      cancelled: true,
      result: failed('campaign cancelled'),
    });
    expect(db.campaignTarget.updateMany.mock.calls[0][0].data.state).toBe('CANCELLED');
    await recordCampaignTargetResult({
      ...base,
      cancelled: true,
      result: success({ prUrl: 'https://github.com/a/b/pull/3' }),
    });
    expect(db.campaignTarget.updateMany.mock.calls[1][0].data.state).toBe('PR_OPENED');
  });

  it('treats a count of 0 (a terminal target) as a no-op', async () => {
    db.campaignTarget.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      recordCampaignTargetResult({ ...base, result: failed() })
    ).resolves.toBeUndefined();
  });
});

describe('recordCampaignState', () => {
  it('moves only a STARTING campaign to RUNNING', async () => {
    await recordCampaignState('c1', 'RUNNING');
    expect(db.campaign.update).toHaveBeenCalledWith({
      data: { state: 'RUNNING' },
      where: { id: 'c1', state: 'STARTING' },
    });
  });

  it('is a no-op when the campaign is no longer STARTING (P2025)', async () => {
    db.campaign.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(recordCampaignState('c1', 'RUNNING')).resolves.toBeUndefined();
  });

  it('rethrows any other database error', async () => {
    db.campaign.update.mockRejectedValue(new Error('connection lost'));
    await expect(recordCampaignState('c1', 'RUNNING')).rejects.toThrow('connection lost');
  });
});

describe('finalizeCampaign', () => {
  const results = [
    {
      connectionId: 'r1',
      result: success({ prUrl: 'https://github.com/a/b/pull/1' }),
      teamId: 't1',
    },
    { connectionId: 'r2', result: success({ changed: false }), teamId: 't2' },
  ];

  it('reconciles every result with team and open-state predicates', async () => {
    await finalizeCampaign({ campaignId: 'c1', cancelled: false, notStarted: [], results });
    expect(db.campaignTarget.updateMany).toHaveBeenCalledTimes(2);
    for (const [arg] of db.campaignTarget.updateMany.mock.calls) {
      expect(arg.where.campaignId).toBe('c1');
      expect(typeof arg.where.teamId).toBe('string');
      expect(arg.where.state).toEqual({ in: ['PENDING', 'RUNNING'] });
    }
    expect(db.campaignTarget.updateMany.mock.calls.map(([a]) => a.where.teamId)).toEqual([
      't1',
      't2',
    ]);
  });

  it('completes cleanly and never moves a terminal campaign', async () => {
    await expect(
      finalizeCampaign({ campaignId: 'c1', cancelled: false, notStarted: [], results })
    ).resolves.toBe('COMPLETED');
    const arg = db.campaign.update.mock.calls[0][0];
    expect(arg.where.id).toBe('c1');
    expect(arg.where.state).toEqual({
      notIn: ['COMPLETED', 'COMPLETED_WITH_FAILURES', 'CANCELLED', 'FAILED_TO_START'],
    });
    expect(arg.data).toMatchObject({ state: 'COMPLETED' });
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it('reports COMPLETED_WITH_FAILURES when a target failed', async () => {
    await expect(
      finalizeCampaign({
        campaignId: 'c1',
        cancelled: false,
        notStarted: [],
        results: [...results, { connectionId: 'r3', result: failed('nope'), teamId: 't1' }],
      })
    ).resolves.toBe('COMPLETED_WITH_FAILURES');
  });

  it('marks targets that never started SKIPPED when the campaign was not cancelled', async () => {
    await expect(
      finalizeCampaign({
        campaignId: 'c1',
        cancelled: false,
        notStarted: [{ connectionId: 'r9', teamId: 't9' }],
        results: [],
      })
    ).resolves.toBe('COMPLETED_WITH_FAILURES');
    const arg = db.campaignTarget.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      campaignId: 'c1',
      connectionId: 'r9',
      state: 'PENDING',
      teamId: 't9',
    });
    expect(arg.data.state).toBe('SKIPPED');
  });

  it('marks targets that never started CANCELLED on a cancel, and keeps finished outcomes', async () => {
    await expect(
      finalizeCampaign({
        campaignId: 'c1',
        cancelled: true,
        notStarted: [{ connectionId: 'r9', teamId: 't9' }],
        results: [
          ...results,
          { connectionId: 'r3', result: failed('campaign cancelled'), teamId: 't1' },
        ],
      })
    ).resolves.toBe('CANCELLED');
    const states = db.campaignTarget.updateMany.mock.calls.map(([a]) => a.data.state);
    expect(states).toEqual(['PR_OPENED', 'NOT_AFFECTED', 'CANCELLED', 'CANCELLED']);
    expect(db.campaign.update.mock.calls[0][0].data.state).toBe('CANCELLED');
  });

  it('is a no-op on the campaign row when it is already terminal (P2025)', async () => {
    db.campaign.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(
      finalizeCampaign({ campaignId: 'c1', cancelled: false, notStarted: [], results })
    ).resolves.toBe('COMPLETED');
  });
});
