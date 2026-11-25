import { randomBytes } from 'node:crypto';
import { verifyCampaignToken } from '@auto-swe/shared/lib/campaignTokenKey';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  campaign: { findUnique: vi.fn(), update: vi.fn() },
  campaignAttempt: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  campaignProposal: { createMany: vi.fn(), findMany: vi.fn() },
  campaignTarget: {
    aggregate: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  organizationMembership: { findUnique: vi.fn() },
  pullRequest: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  workflowRun: { aggregate: vi.fn(), updateMany: vi.fn() },
}));
const settings = vi.hoisted(() => ({ disabledTeams: new Set<string>(), maxTargets: 50 }));
const reconcile = vi.hoisted(() => ({ fn: vi.fn() }));
const temporal = vi.hoisted(() => ({ cancel: vi.fn(), getHandle: vi.fn() }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string, ctx: { teamId: string }) => {
    if (key === 'workflow.campaignsEnabled') {
      return !settings.disabledTeams.has(ctx.teamId);
    }
    if (key === 'workflow.campaignMaxTargets') {
      return settings.maxTargets;
    }
    throw new Error(`unexpected setting ${key}`);
  }),
}));
vi.mock('../lib/campaignAttempts.js', () => ({ reconcileCampaignAttempt: reconcile.fn }));
vi.mock('../lib/temporalClient.js', () => ({
  getTemporalClient: () => ({ workflow: { getHandle: temporal.getHandle } }),
}));

import {
  attemptIdempotencyKey,
  cancelCampaignAttempts,
  finalizeCampaignReconciler,
  readCampaignPass,
  recordCampaignPass,
  startCampaignAttempt,
} from './campaignReconciler.js';

const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';
const TEAM = '66666666-6666-4666-8666-666666666666';

beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});

const campaignRow = (over: Record<string, unknown> = {}) => ({
  budgetUsd: null,
  expiresAt: null,
  gate: 'OPENED',
  launchedById: 'user-1',
  maxOpenPullRequests: 5,
  maxParallel: 3,
  orgId: ORG,
  ownerTeamId: TEAM,
  plan: 'UNIFORM',
  recipeRef: 'npm-dependency@2',
  rescanIntervalHours: 24,
  scopeKind: null,
  staleAfterDays: 14,
  state: 'ACTIVE',
  ...over,
});

const targetRow = (over: Record<string, unknown> = {}) => ({
  attempts: [],
  brief: null,
  connectionId: 'conn-1',
  dependsOn: [],
  failureReason: null,
  id: TARGET,
  lastCheckedAt: null,
  position: 0,
  regressions: 0,
  repoLabel: 'acme/api',
  staleSince: null,
  state: 'PENDING',
  teamId: TEAM,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  settings.disabledTeams.clear();
  settings.maxTargets = 50;
  db.campaign.findUnique.mockResolvedValue(campaignRow());
  db.campaignTarget.findMany.mockResolvedValue([targetRow()]);
  db.campaignProposal.findMany.mockResolvedValue([]);
  db.pullRequest.findMany.mockResolvedValue([]);
  db.user.findUnique.mockResolvedValue({ isActive: true, role: 'USER' });
  db.organizationMembership.findUnique.mockResolvedValue({ userId: 'user-1' });
  db.campaignTarget.updateMany.mockResolvedValue({ count: 1 });
  db.campaignAttempt.updateMany.mockResolvedValue({ count: 1 });
  db.campaignAttempt.findMany.mockResolvedValue([]);
});

describe('readCampaignPass', () => {
  it('is null for a campaign that no longer exists', async () => {
    db.campaign.findUnique.mockResolvedValue(null);
    await expect(readCampaignPass({ campaignId: CAMPAIGN })).resolves.toBeNull();
  });

  it('reads the targets under the campaign’s tenant, in position order', async () => {
    await readCampaignPass({ campaignId: CAMPAIGN });
    const arg = db.campaignTarget.findMany.mock.calls[0]?.[0];
    expect(arg.where).toEqual({ campaign: { orgId: ORG }, campaignId: CAMPAIGN });
    expect(arg.orderBy).toEqual([{ position: 'asc' }, { id: 'asc' }]);
  });

  it('describes the campaign, its gates and its targets', async () => {
    db.campaign.findUnique.mockResolvedValue(
      campaignRow({ expiresAt: new Date(2_000_000), scopeKind: 'TEAM' })
    );
    db.campaignTarget.findMany.mockResolvedValue([
      targetRow({
        attempts: [
          {
            childWorkflowId: 'w1',
            failureReason: null,
            id: 'a1',
            n: 2,
            outcome: 'PR_OPENED',
            runId: 'run-1',
            startedAt: new Date(0),
          },
        ],
        lastCheckedAt: new Date(5000),
        staleSince: new Date(6000),
        state: 'PR_OPENED',
      }),
    ]);
    db.pullRequest.findMany.mockResolvedValue([
      { openedAt: new Date(7000), runId: 'run-1', status: 'OPEN' },
    ]);
    db.campaignProposal.findMany.mockResolvedValue([{ connectionId: 'conn-9' }]);
    const snap = await readCampaignPass({ campaignId: CAMPAIGN });
    expect(snap?.campaign).toMatchObject({
      budgetExceeded: false,
      campaignsEnabled: true,
      expiresAt: 2_000_000,
      gate: 'OPENED',
      hasCheck: true,
      hasScope: true,
      launcherAvailable: true,
      maxOpenPullRequests: 5,
      maxParallel: 3,
      maxTargets: 50,
      plan: 'UNIFORM',
      state: 'ACTIVE',
    });
    expect(snap?.proposalConnectionIds).toEqual(['conn-9']);
    expect(snap?.planned).toBe(false);
    expect(snap?.targets[0]).toMatchObject({
      attemptN: 2,
      attemptOutcome: 'PR_OPENED',
      id: TARGET,
      label: 'acme/api',
      lastCheckedAt: 5000,
      prOpenedAt: 7000,
      prStatus: 'OPEN',
      staleSince: 6000,
      state: 'PR_OPENED',
    });
  });

  it('says a campaign is planned once any target carries a brief, and has no check for a @1 recipe', async () => {
    db.campaign.findUnique.mockResolvedValue(campaignRow({ recipeRef: 'npm-dependency@1' }));
    db.campaignTarget.findMany.mockResolvedValue([targetRow({ brief: 'Bump it in the API' })]);
    const snap = await readCampaignPass({ campaignId: CAMPAIGN });
    expect(snap?.planned).toBe(true);
    expect(snap?.campaign.hasCheck).toBe(false);
  });

  it('turns the kill switch off when any live target’s team has it off, but not a finished one’s', async () => {
    db.campaignTarget.findMany.mockResolvedValue([
      targetRow({ id: 'a', state: 'PENDING', teamId: 'team-b' }),
    ]);
    settings.disabledTeams.add('team-b');
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.campaignsEnabled).toBe(
      false
    );
    db.campaignTarget.findMany.mockResolvedValue([
      targetRow({ id: 'a', state: 'SATISFIED', teamId: 'team-b' }),
    ]);
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.campaignsEnabled).toBe(
      true
    );
  });

  it('reports an unavailable launcher: no launcher, a deactivated one, or one who left the organization', async () => {
    db.campaign.findUnique.mockResolvedValue(campaignRow({ launchedById: null }));
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.launcherAvailable).toBe(
      false
    );
    db.campaign.findUnique.mockResolvedValue(campaignRow());
    db.user.findUnique.mockResolvedValue({ isActive: false, role: 'USER' });
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.launcherAvailable).toBe(
      false
    );
    db.user.findUnique.mockResolvedValue({ isActive: true, role: 'USER' });
    db.organizationMembership.findUnique.mockResolvedValue(null);
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.launcherAvailable).toBe(
      false
    );
    // An admin needs no membership.
    db.user.findUnique.mockResolvedValue({ isActive: true, role: 'ADMIN' });
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.launcherAvailable).toBe(
      true
    );
  });

  it('reports a spent budget from the campaign’s attempts this month', async () => {
    db.campaign.findUnique.mockResolvedValue(campaignRow({ budgetUsd: '10' }));
    db.workflowRun.aggregate.mockResolvedValue({ _sum: { costUsdAccrued: 10 } });
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.budgetExceeded).toBe(true);
    const where = db.workflowRun.aggregate.mock.calls[0]?.[0].where;
    expect(where.campaignAttempts.some.target).toEqual({ campaignId: CAMPAIGN });
    expect(where.campaignAttempts.some.startedAt.gte).toBeInstanceOf(Date);
    db.workflowRun.aggregate.mockResolvedValue({ _sum: { costUsdAccrued: 9.99 } });
    expect((await readCampaignPass({ campaignId: CAMPAIGN }))?.campaign.budgetExceeded).toBe(false);
  });

  it('does not read the spend of a campaign with no budget', async () => {
    await readCampaignPass({ campaignId: CAMPAIGN });
    expect(db.workflowRun.aggregate).not.toHaveBeenCalled();
  });

  it('settles a running target’s unrecorded attempt and reports how it ended', async () => {
    db.campaignTarget.findMany.mockResolvedValue([
      targetRow({
        attempts: [
          {
            childWorkflowId: 'campaign-w1',
            failureReason: null,
            id: 'a1',
            n: 1,
            outcome: null,
            runId: null,
            startedAt: new Date(0),
          },
        ],
        state: 'RUNNING',
      }),
    ]);
    reconcile.fn.mockResolvedValue({ attemptId: 'a1' });
    db.campaignAttempt.findUnique.mockResolvedValue({
      failureReason: 'the original tests failed',
      outcome: 'FAILED',
      runId: 'run-1',
    });
    const snap = await readCampaignPass({ campaignId: CAMPAIGN });
    expect(reconcile.fn).toHaveBeenCalledTimes(1);
    expect(reconcile.fn.mock.calls[0]?.[0]).toMatchObject({
      campaignWorkflowId: `campaign-${CAMPAIGN}`,
      childWorkflowId: 'campaign-w1',
      id: 'a1',
      targetId: TARGET,
    });
    expect(snap?.targets[0]).toMatchObject({
      attemptFailureReason: 'the original tests failed',
      attemptOutcome: 'FAILED',
    });
  });

  it('does not reconcile the attempt of a target that is not running', async () => {
    db.campaignTarget.findMany.mockResolvedValue([
      targetRow({
        attempts: [
          {
            childWorkflowId: 'w',
            failureReason: null,
            id: 'a1',
            n: 1,
            outcome: null,
            runId: null,
            startedAt: new Date(0),
          },
        ],
        state: 'PENDING',
      }),
    ]);
    await readCampaignPass({ campaignId: CAMPAIGN });
    expect(reconcile.fn).not.toHaveBeenCalled();
  });
});

describe('recordCampaignPass', () => {
  const base = { addTargets: [], campaignId: CAMPAIGN, proposals: [], updates: [] };

  it('writes a transition conditionally on the state it was decided from', async () => {
    await recordCampaignPass({
      ...base,
      updates: [
        {
          expect: 'RUNNING',
          failureReason: 'boom',
          regressions: 1,
          state: 'NEEDS_ATTENTION',
          targetId: TARGET,
          teamId: TEAM,
        },
      ],
    });
    const arg = db.campaignTarget.updateMany.mock.calls[0]?.[0];
    expect(arg.where).toEqual({
      campaignId: CAMPAIGN,
      id: TARGET,
      state: 'RUNNING',
      teamId: TEAM,
    });
    expect(arg.data).toMatchObject({
      failureReason: 'boom',
      regressions: 1,
      state: 'NEEDS_ATTENTION',
    });
    expect(arg.data.finishedAt).toBeUndefined();
  });

  it('stamps finishedAt when a target becomes final, and clears it on PENDING', async () => {
    await recordCampaignPass({
      ...base,
      updates: [
        { expect: 'MERGED', state: 'SATISFIED', targetId: TARGET, teamId: TEAM },
        { expect: 'BLOCKED', state: 'PENDING', targetId: 'other', teamId: TEAM },
      ],
    });
    expect(db.campaignTarget.updateMany.mock.calls[0]?.[0].data.finishedAt).toBeInstanceOf(Date);
    expect(db.campaignTarget.updateMany.mock.calls[1]?.[0].data.finishedAt).toBeNull();
  });

  it('never writes a row that was read in a final state', async () => {
    const r = await recordCampaignPass({
      ...base,
      updates: [
        { expect: 'SATISFIED', state: 'PENDING', targetId: TARGET, teamId: TEAM },
        { expect: 'SKIPPED', state: 'PENDING', targetId: TARGET, teamId: TEAM },
        { expect: 'CANCELLED', state: 'PENDING', targetId: TARGET, teamId: TEAM },
        { expect: 'NOT_AFFECTED', state: 'PENDING', targetId: TARGET, teamId: TEAM },
      ],
    });
    expect(db.campaignTarget.updateMany).not.toHaveBeenCalled();
    expect(r.skipped).toBe(4);
  });

  it('counts an update whose condition no longer holds as skipped, not as an error', async () => {
    db.campaignTarget.updateMany.mockResolvedValue({ count: 0 });
    const r = await recordCampaignPass({
      ...base,
      updates: [{ expect: 'PENDING', state: 'BLOCKED', targetId: TARGET, teamId: TEAM }],
    });
    expect(r.skipped).toBe(1);
  });

  it('masks and bounds a failure reason', async () => {
    await recordCampaignPass({
      ...base,
      updates: [
        {
          expect: 'PENDING',
          failureReason: `token ghp_${'a'.repeat(36)} ${'x'.repeat(2000)}`,
          state: 'SKIPPED',
          targetId: TARGET,
          teamId: TEAM,
        },
      ],
    });
    const reason = db.campaignTarget.updateMany.mock.calls[0]?.[0].data.failureReason as string;
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).not.toContain('ghp_aaaa');
  });

  it('appends discovered targets after the last position and returns them', async () => {
    db.campaign.findUnique.mockResolvedValue({ orgId: ORG });
    db.campaignTarget.aggregate.mockResolvedValue({ _max: { position: 4 } });
    db.campaignTarget.createMany.mockResolvedValue({ count: 2 });
    db.campaignTarget.findMany.mockResolvedValue([
      { connectionId: 'c-a', id: 'n1', position: 5, repoLabel: 'acme/a', teamId: TEAM },
      { connectionId: 'c-b', id: 'n2', position: 6, repoLabel: 'acme/b', teamId: TEAM },
    ]);
    const r = await recordCampaignPass({
      ...base,
      addTargets: [
        { connectionId: 'c-a', label: 'acme/a', teamId: TEAM },
        { connectionId: 'c-b', label: 'acme/b', teamId: TEAM },
      ],
    });
    const created = db.campaignTarget.createMany.mock.calls[0]?.[0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map((d: { position: number }) => d.position)).toEqual([5, 6]);
    expect(created.data[0]).toMatchObject({
      campaignId: CAMPAIGN,
      connectionId: 'c-a',
      evidence: { kind: 'discovered' },
      teamId: TEAM,
    });
    expect(r.added).toEqual([
      { connectionId: 'c-a', label: 'acme/a', position: 5, targetId: 'n1', teamId: TEAM },
      { connectionId: 'c-b', label: 'acme/b', position: 6, targetId: 'n2', teamId: TEAM },
    ]);
    // The read-back is scoped to the campaign's tenant and to the positions just assigned.
    const where = db.campaignTarget.findMany.mock.calls[0]?.[0].where;
    expect(where.campaign).toEqual({ orgId: ORG });
    expect(where.position).toEqual({ gte: 5, lt: 7 });
  });

  it('records proposals once', async () => {
    db.campaignProposal.createMany.mockResolvedValue({ count: 1 });
    await recordCampaignPass({
      ...base,
      proposals: [{ connectionId: 'c-x', reason: 'the launcher does not lead the team' }],
    });
    expect(db.campaignProposal.createMany).toHaveBeenCalledWith({
      data: [
        {
          campaignId: CAMPAIGN,
          connectionId: 'c-x',
          reason: 'the launcher does not lead the team',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('moves the campaign only from the state it was decided from', async () => {
    db.campaign.update.mockResolvedValue({});
    const r = await recordCampaignPass({
      ...base,
      campaign: { from: 'ACTIVE', pausedReason: 'budget', to: 'PAUSED' },
    });
    expect(db.campaign.update).toHaveBeenCalledWith({
      data: { pausedReason: 'budget', state: 'PAUSED' },
      where: { id: CAMPAIGN, state: 'ACTIVE' },
    });
    expect(r.campaignChanged).toBe(true);
  });

  it('stamps completedAt when the campaign completes and clears the pause reason when it resumes', async () => {
    db.campaign.update.mockResolvedValue({});
    await recordCampaignPass({ ...base, campaign: { from: 'ACTIVE', to: 'COMPLETED' } });
    expect(db.campaign.update.mock.calls[0]?.[0].data).toMatchObject({
      pausedReason: null,
      state: 'COMPLETED',
    });
    expect(db.campaign.update.mock.calls[0]?.[0].data.completedAt).toBeInstanceOf(Date);
    await recordCampaignPass({ ...base, campaign: { from: 'MONITORING', to: 'ACTIVE' } });
    expect(db.campaign.update.mock.calls[1]?.[0].data).toEqual({
      pausedReason: null,
      state: 'ACTIVE',
    });
  });

  it('treats a campaign that moved on as unchanged, and never moves a final one', async () => {
    db.campaign.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    const r = await recordCampaignPass({
      ...base,
      campaign: { from: 'ACTIVE', to: 'MONITORING' },
    });
    expect(r.campaignChanged).toBe(false);
    db.campaign.update.mockClear();
    await recordCampaignPass({ ...base, campaign: { from: 'CANCELLED', to: 'ACTIVE' } });
    expect(db.campaign.update).not.toHaveBeenCalled();
  });

  it('rethrows any other database error', async () => {
    db.campaign.update.mockRejectedValue(new Error('connection lost'));
    await expect(
      recordCampaignPass({ ...base, campaign: { from: 'ACTIVE', to: 'MONITORING' } })
    ).rejects.toThrow('connection lost');
  });
});

describe('startCampaignAttempt', () => {
  const input = { attemptN: 2, campaignId: CAMPAIGN, targetId: TARGET };

  function gatewayFetch(status: number, body: unknown) {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const impl = (async (url: URL, init: RequestInit) => {
      calls.push({ init, url });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it('posts to the attempt route with a call-scoped token and a per-attempt idempotency key', async () => {
    const { calls, impl } = gatewayFetch(201, {
      attemptId: 'att-1',
      branch: 'auto/CAMPAIGN-x-2',
      n: 2,
      runId: null,
      workflowId: 'campaign-w',
    });
    const r = await startCampaignAttempt(input, {
      baseUrl: 'http://gateway.internal:8080',
      fetchImpl: impl,
    });
    expect(r).toEqual({
      attemptId: 'att-1',
      n: 2,
      ok: true,
      runId: null,
      workflowId: 'campaign-w',
    });
    const { init, url } = calls[0] ?? { init: {}, url: new URL('http://missing') };
    expect(url.href).toBe(
      `http://gateway.internal:8080/api/v1/campaigns/${CAMPAIGN}/targets/${TARGET}/attempts`
    );
    expect(init.redirect).toBe('error');
    const key = attemptIdempotencyKey(CAMPAIGN, TARGET, 2);
    expect(JSON.parse(init.body as string)).toEqual({ idempotencyKey: key });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(key);
    const bearer = (init.headers as Record<string, string>).Authorization as string;
    const verified = verifyCampaignToken(bearer.slice('Bearer '.length));
    expect(verified).toMatchObject({
      call: 'startAttempt',
      campaignId: CAMPAIGN,
      ok: true,
      targetId: TARGET,
    });
  });

  it('uses the same key for the same attempt and a different one for the next', () => {
    expect(attemptIdempotencyKey(CAMPAIGN, TARGET, 2)).toBe(
      attemptIdempotencyKey(CAMPAIGN, TARGET, 2)
    );
    expect(attemptIdempotencyKey(CAMPAIGN, TARGET, 2)).not.toBe(
      attemptIdempotencyKey(CAMPAIGN, TARGET, 3)
    );
  });

  it('answers a coded refusal as a result, not an error', async () => {
    const { impl } = gatewayFetch(409, {
      error: { code: 'MAX_OPEN_PULL_REQUESTS', message: 'Too many drafts are open' },
    });
    await expect(
      startCampaignAttempt(input, { baseUrl: 'http://gw:8080', fetchImpl: impl })
    ).resolves.toEqual({
      code: 'MAX_OPEN_PULL_REQUESTS',
      message: 'Too many drafts are open',
      ok: false,
    });
  });

  it('reads a flat refusal body too, and never echoes a token that was in the message', async () => {
    const { impl } = gatewayFetch(403, {
      code: 'LAUNCH_REFUSED',
      message: 'refused camp_abc.def for the launcher',
    });
    const r = await startCampaignAttempt(input, { baseUrl: 'http://gw:8080', fetchImpl: impl });
    expect(r).toMatchObject({ code: 'LAUNCH_REFUSED', ok: false });
    expect((r as { message: string }).message).not.toContain('camp_abc');
  });

  it('reads a 404 with no code as the target being unavailable', async () => {
    const { impl } = gatewayFetch(404, { error: { message: 'Not found' } });
    await expect(
      startCampaignAttempt(input, { baseUrl: 'http://gw:8080', fetchImpl: impl })
    ).resolves.toMatchObject({ code: 'TARGET_UNAVAILABLE', ok: false });
  });

  it('throws on a server error, so Temporal retries with the same key', async () => {
    const { impl } = gatewayFetch(503, 'unavailable');
    await expect(
      startCampaignAttempt(input, { baseUrl: 'http://gw:8080', fetchImpl: impl })
    ).rejects.toThrow(/HTTP 503/);
  });

  it('throws on a started attempt it cannot read, and on a refusal with no code', async () => {
    await expect(
      startCampaignAttempt(input, {
        baseUrl: 'http://gw:8080',
        fetchImpl: gatewayFetch(201, { nope: true }).impl,
      })
    ).rejects.toThrow(/not readable/);
    await expect(
      startCampaignAttempt(input, {
        baseUrl: 'http://gw:8080',
        fetchImpl: gatewayFetch(401, { error: { message: 'bad token' } }).impl,
      })
    ).rejects.toThrow(/without a refusal code/);
  });

  it('refuses ids that are not uuids before any request', async () => {
    const { calls, impl } = gatewayFetch(201, {});
    await expect(
      startCampaignAttempt(
        { ...input, targetId: '../../etc' },
        { baseUrl: 'http://gw:8080', fetchImpl: impl }
      )
    ).rejects.toThrow(/not a uuid/);
    expect(calls).toHaveLength(0);
  });
});

describe('cancelCampaignAttempts', () => {
  it('cancels each in-flight attempt’s workflow, marks its run and closes the attempt', async () => {
    db.campaignAttempt.findMany.mockResolvedValue([
      { childWorkflowId: 'w1', id: 'a1', runId: 'run-1' },
      { childWorkflowId: 'w2', id: 'a2', runId: null },
    ]);
    temporal.getHandle.mockReturnValue({ cancel: temporal.cancel });
    temporal.cancel.mockResolvedValue(undefined);
    db.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    const r = await cancelCampaignAttempts({ campaignId: CAMPAIGN });
    expect(r).toEqual({ cancelled: 2 });
    expect(db.campaignAttempt.findMany.mock.calls[0]?.[0].where).toEqual({
      outcome: null,
      target: { campaignId: CAMPAIGN },
    });
    expect(temporal.getHandle.mock.calls.map((c) => c[0])).toEqual(['w1', 'w2']);
    expect(db.workflowRun.updateMany).toHaveBeenCalledTimes(1);
    expect(db.workflowRun.updateMany).toHaveBeenCalledWith({
      data: { status: 'CANCELLED' },
      where: { id: 'run-1', status: 'RUNNING' },
    });
    expect(db.campaignAttempt.updateMany).toHaveBeenCalledTimes(2);
    expect(db.campaignAttempt.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { outcome: 'CANCELLED' },
      where: { id: 'a1', outcome: null },
    });
  });

  it('counts a workflow Temporal no longer knows as cancelled, and carries on past a real failure', async () => {
    db.campaignAttempt.findMany.mockResolvedValue([
      { childWorkflowId: 'w1', id: 'a1', runId: null },
      { childWorkflowId: 'w2', id: 'a2', runId: null },
      { childWorkflowId: 'w3', id: 'a3', runId: null },
    ]);
    temporal.getHandle.mockReturnValue({ cancel: temporal.cancel });
    temporal.cancel
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'WorkflowNotFoundError' }))
      .mockRejectedValueOnce(new Error('temporal is down'))
      .mockResolvedValueOnce(undefined);
    const r = await cancelCampaignAttempts({ campaignId: CAMPAIGN });
    expect(r).toEqual({ cancelled: 2 });
  });
});

describe('finalizeCampaignReconciler', () => {
  it('cancels the targets that delivered nothing and the campaign, and leaves drafts alone', async () => {
    db.campaign.findUnique.mockResolvedValue({ orgId: ORG });
    db.campaign.update.mockResolvedValue({});
    await finalizeCampaignReconciler({ campaignId: CAMPAIGN, outcome: 'CANCELLED' });
    const arg = db.campaignTarget.updateMany.mock.calls[0]?.[0];
    expect(arg.where.campaign).toEqual({ orgId: ORG });
    expect(arg.where.campaignId).toBe(CAMPAIGN);
    expect([...arg.where.state.in].sort()).toEqual(
      ['BLOCKED', 'FAILED', 'NEEDS_ATTENTION', 'PENDING', 'RUNNING'].sort()
    );
    expect(arg.data.state).toBe('CANCELLED');
    const campaignWrite = db.campaign.update.mock.calls[0]?.[0];
    expect(campaignWrite.data.state).toBe('CANCELLED');
    expect(campaignWrite.where.state.notIn).toContain('COMPLETED');
  });

  it('is a no-op for a campaign that is already final', async () => {
    db.campaign.findUnique.mockResolvedValue({ orgId: ORG });
    db.campaign.update.mockRejectedValue(Object.assign(new Error('gone'), { code: 'P2025' }));
    await expect(
      finalizeCampaignReconciler({ campaignId: CAMPAIGN, outcome: 'CANCELLED' })
    ).resolves.toBeUndefined();
  });

  it('only makes sure completedAt is set for a completed campaign', async () => {
    db.campaign.update.mockResolvedValue({});
    await finalizeCampaignReconciler({ campaignId: CAMPAIGN, outcome: 'COMPLETED' });
    expect(db.campaignTarget.updateMany).not.toHaveBeenCalled();
    expect(db.campaign.update.mock.calls[0]?.[0].where).toEqual({
      completedAt: null,
      id: CAMPAIGN,
      state: 'COMPLETED',
    });
  });
});
