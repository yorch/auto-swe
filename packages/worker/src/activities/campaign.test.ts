import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn(), update: vi.fn() },
  campaignTarget: { updateMany: vi.fn() },
  connection: { findUnique: vi.fn() },
  teamMembership: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const settings = vi.hoisted(() => ({ disabledTeams: new Set<string>() }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string, ctx: { teamId: string }) => {
    if (key !== 'workflow.campaignsEnabled') {
      throw new Error(`unexpected setting ${key}`);
    }
    return !settings.disabledTeams.has(ctx.teamId);
  }),
}));

import {
  authorizeCampaignTargets,
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

describe('authorizeCampaignTargets', () => {
  /** teamId -> role of the launcher on it. */
  let roles: Record<string, string>;
  /** connectionId -> its row now. */
  let repos: Record<string, { isActive: boolean; type: string; teamId: string; orgId: string }>;
  let launcher: { isActive: boolean; role: string } | null;

  beforeEach(() => {
    settings.disabledTeams = new Set();
    roles = { owner: 'LEAD', t1: 'LEAD', t2: 'LEAD' };
    repos = {
      r1: { isActive: true, orgId: 'org-1', teamId: 't1', type: 'git_repo' },
      r2: { isActive: true, orgId: 'org-1', teamId: 't2', type: 'git_repo' },
    };
    launcher = { isActive: true, role: 'LEAD' };
    db.campaign.findUnique.mockResolvedValue({
      orgId: 'org-1',
      ownerTeamId: 'owner',
      state: 'RUNNING',
    });
    db.user.findUnique.mockImplementation(async () => launcher);
    db.teamMembership.findUnique.mockImplementation(
      async (args: { where: { userId_teamId: { teamId: string } } }) => {
        const role = roles[args.where.userId_teamId.teamId];
        return role ? { role } : null;
      }
    );
    db.connection.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      const r = repos[args.where.id];
      return r
        ? { isActive: r.isActive, team: { orgId: r.orgId }, teamId: r.teamId, type: r.type }
        : null;
    });
  });

  const check = () =>
    authorizeCampaignTargets({
      campaignId: 'c1',
      launchedById: 'u1',
      targets: [
        { connectionId: 'r1', teamId: 't1' },
        { connectionId: 'r2', teamId: 't2' },
      ],
    });

  it('allows targets whose launch still holds', async () => {
    expect(await check()).toEqual({
      verdicts: [
        { allowed: true, connectionId: 'r1' },
        { allowed: true, connectionId: 'r2' },
      ],
    });
  });

  it('stops everything when the owning team turned the kill switch off', async () => {
    settings.disabledTeams.add('owner');
    expect((await check()).stopReason).toMatch(/turned off for the owning team/);
  });

  it('stops everything when the launcher was deactivated or no longer leads the owning team', async () => {
    launcher = { isActive: false, role: 'LEAD' };
    expect((await check()).stopReason).toMatch(/no longer active/);
    launcher = { isActive: true, role: 'LEAD' };
    roles.owner = 'ENGINEER';
    expect((await check()).stopReason).toMatch(/no longer leads the owning team/);
  });

  it('refuses one target whose repository went inactive, moved team or left the org', async () => {
    repos.r1 = { ...repos.r1, isActive: false } as (typeof repos)['r1'];
    expect((await check()).verdicts[0]).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/no longer an active git repository/),
    });
    repos.r1 = { isActive: true, orgId: 'org-1', teamId: 't2', type: 'git_repo' };
    expect((await check()).verdicts[0]?.reason).toMatch(/moved to another team/);
    repos.r1 = { isActive: true, orgId: 'org-2', teamId: 't1', type: 'git_repo' };
    expect((await check()).verdicts[0]?.reason).toMatch(/organization/);
    delete repos.r1;
    expect((await check()).verdicts[0]?.allowed).toBe(false);
    // The other target is judged on its own.
    expect((await check()).verdicts[1]).toEqual({ allowed: true, connectionId: 'r2' });
  });

  it('refuses a target whose team turned the kill switch off or no longer has the launcher as LEAD', async () => {
    settings.disabledTeams.add('t1');
    roles.t2 = 'ENGINEER';
    const { verdicts } = await check();
    expect(verdicts[0]?.reason).toMatch(/turned off for the repository's team/);
    expect(verdicts[1]?.reason).toMatch(/no longer leads the team that owns the repository/);
  });

  it('lets a platform ADMIN through the team-lead checks but not the kill switch', async () => {
    launcher = { isActive: true, role: 'ADMIN' };
    roles = {};
    settings.disabledTeams.add('t2');
    const { verdicts, stopReason } = await check();
    expect(stopReason).toBeUndefined();
    expect(verdicts[0]).toEqual({ allowed: true, connectionId: 'r1' });
    expect(verdicts[1]?.allowed).toBe(false);
  });

  it('reads the campaign state', async () => {
    await check();
    expect(db.campaign.findUnique.mock.calls[0]?.[0]).toMatchObject({
      select: { state: true },
    });
  });

  it.each(['STARTING', 'RUNNING'])('lets a %s campaign start children', async (state) => {
    db.campaign.findUnique.mockResolvedValue({ orgId: 'org-1', ownerTeamId: 'owner', state });
    const v = await check();
    expect(v.stopReason).toBeUndefined();
    expect(v.cancelled).toBeUndefined();
    expect(v.verdicts.every((x) => x.allowed)).toBe(true);
  });

  it.each(['CANCELLING', 'CANCELLED'])(
    'stops a %s campaign as a cancel, whatever the launch still allows',
    async (state) => {
      db.campaign.findUnique.mockResolvedValue({ orgId: 'org-1', ownerTeamId: 'owner', state });
      expect(await check()).toEqual({
        cancelled: true,
        stopReason: 'the campaign was cancelled',
        verdicts: [],
      });
      // Decided before anything else is read.
      expect(db.user.findUnique).not.toHaveBeenCalled();
    }
  );

  it.each(['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED_TO_START'])(
    'stops a %s campaign: a final campaign never grows a child',
    async (state) => {
      db.campaign.findUnique.mockResolvedValue({ orgId: 'org-1', ownerTeamId: 'owner', state });
      const v = await check();
      expect(v.stopReason).toBe(`the campaign is already ${state}`);
      expect(v.cancelled).toBeUndefined();
      expect(v.verdicts).toEqual([]);
    }
  );

  it('stops when the campaign row is gone', async () => {
    db.campaign.findUnique.mockResolvedValue(null);
    expect((await check()).stopReason).toMatch(/no longer exists/);
  });
});
