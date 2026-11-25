import { CancelledFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  campaign: { findUnique: vi.fn() },
  campaignDiscoveryCheck: { deleteMany: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  campaignProposal: { findMany: vi.fn() },
  campaignTarget: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  connection: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const perms = vi.hoisted(() => ({ can: vi.fn() }));
const enabled = vi.hoisted(() => ({ off: new Set<string>() }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(
    async (_key: string, ctx: { teamId: string }) => !enabled.off.has(ctx.teamId)
  ),
}));
vi.mock('@auto-swe/shared/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/permissions')>()),
  can: perms.can,
}));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('./shellStep.js', () => ({ runShellCheck: vi.fn() }));

import { MERGE_NOT_SATISFIED_REASON } from '../workflows/campaignReconcilerPass.js';
import {
  type CheckDeps,
  DISCOVERY_CHUNK,
  discoverCampaignTargets,
  runCampaignCheck,
} from './campaignCheck.js';

const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';
const TEAM = '66666666-6666-4666-8666-666666666666';
const SHA = 'b'.repeat(40);

const SATISFIED_OUT = {
  baseSha: SHA,
  exitCode: 0,
  stdout:
    'lodash is at 4.17.21\nCAMPAIGN_CHECK evidence=declared-at-target detail=at-target declared=4.17.21 resolved=-\n',
};
const NOT_SATISFIED_OUT = {
  baseSha: SHA,
  exitCode: 1,
  stdout:
    'lodash is below\nCAMPAIGN_CHECK evidence=below-target detail=below declared=4.17.20 resolved=-\n',
};

const runner = (out: Awaited<ReturnType<CheckDeps['run']>>) => {
  const run = vi.fn().mockResolvedValue(out);
  return { deps: { run } as CheckDeps, run };
};

beforeEach(() => {
  vi.clearAllMocks();
  enabled.off.clear();
  db.campaign.findUnique.mockResolvedValue({
    orgId: ORG,
    recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
    recipeRef: 'npm-dependency@2',
    state: 'ACTIVE',
  });
  db.campaignTarget.findFirst.mockResolvedValue({
    connectionId: 'conn-1',
    lastCheckedAt: null,
    regressions: 0,
    state: 'MERGED',
    teamId: TEAM,
  });
  db.campaignTarget.updateMany.mockResolvedValue({ count: 1 });
});

describe('runCampaignCheck', () => {
  it('finishes a merged target whose check passes, with the evidence and the checked sha', async () => {
    const { deps, run } = runner(SATISFIED_OUT);
    const r = await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps);

    expect(r).toMatchObject({
      changed: true,
      failureReason: null,
      regressions: 0,
      state: 'SATISFIED',
      status: 'satisfied',
    });
    // The recipe's read-only script runs against the target's repository, with no apply.
    const call = run.mock.calls[0]?.[0];
    expect(call.repoId).toBe('conn-1');
    expect(call.command).toContain('CAMPAIGN_CHECK');
    expect(call.command).not.toMatch(/npm install|go get/);
    const arg = db.campaignTarget.updateMany.mock.calls[0]?.[0];
    expect(arg.where).toEqual({
      campaignId: CAMPAIGN,
      id: TARGET,
      state: 'MERGED',
      teamId: TEAM,
    });
    expect(arg.data).toMatchObject({
      evidence: { declared: '4.17.21', kind: 'declared-at-target', ref: 'npm-dependency@2' },
      lastCheckedSha: SHA,
      staleSince: null,
      state: 'SATISFIED',
    });
    expect(arg.data.finishedAt).toBeInstanceOf(Date);
    expect(arg.data.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('sends a merged target whose check still fails to NEEDS_ATTENTION with the reason', async () => {
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner(NOT_SATISFIED_OUT).deps
    );
    expect(r).toMatchObject({ changed: true, state: 'NEEDS_ATTENTION', status: 'not-satisfied' });
    expect(db.campaignTarget.updateMany.mock.calls[0]?.[0].data).toMatchObject({
      failureReason: MERGE_NOT_SATISFIED_REASON,
      state: 'NEEDS_ATTENTION',
    });
  });

  it('returns a regressed satisfied target to PENDING with one more regression, and reopens it', async () => {
    db.campaignTarget.findFirst.mockResolvedValue({
      connectionId: 'conn-1',
      lastCheckedAt: new Date(1000),
      regressions: 1,
      state: 'SATISFIED',
      teamId: TEAM,
    });
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner(NOT_SATISFIED_OUT).deps
    );
    expect(r).toMatchObject({ changed: true, regressions: 2, state: 'PENDING' });
    const data = db.campaignTarget.updateMany.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ failureReason: null, regressions: 2, state: 'PENDING' });
    expect(data.finishedAt).toBeNull();
  });

  it('needs a person once a target regressed past the limit', async () => {
    db.campaignTarget.findFirst.mockResolvedValue({
      connectionId: 'conn-1',
      lastCheckedAt: null,
      regressions: 3,
      state: 'SATISFIED',
      teamId: TEAM,
    });
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner(NOT_SATISFIED_OUT).deps
    );
    expect(r).toMatchObject({ regressions: 4, state: 'NEEDS_ATTENTION' });
    expect(db.campaignTarget.updateMany.mock.calls[0]?.[0].data.failureReason).toMatch(/regressed/);
  });

  it('records a satisfied target that is still satisfied without moving it', async () => {
    db.campaignTarget.findFirst.mockResolvedValue({
      connectionId: 'conn-1',
      lastCheckedAt: new Date(1000),
      regressions: 0,
      state: 'SATISFIED',
      teamId: TEAM,
    });
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner(SATISFIED_OUT).deps
    );
    expect(r).toMatchObject({ changed: false, state: 'SATISFIED', status: 'satisfied' });
    const data = db.campaignTarget.updateMany.mock.calls[0]?.[0].data;
    expect(data.state).toBeUndefined();
    expect(data.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('fails closed: a check that gave no answer leaves the state and records why', async () => {
    const { deps } = runner({ baseSha: SHA, exitCode: 3, stdout: '' });
    const r = await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps);
    expect(r).toMatchObject({ changed: false, state: 'MERGED', status: 'could-not-run' });
    const data = db.campaignTarget.updateMany.mock.calls[0]?.[0].data;
    expect(data.state).toBeUndefined();
    expect(data.regressions).toBeUndefined();
    expect(data.evidence).toMatchObject({ kind: 'cannot-check', ref: 'npm-dependency@2' });
    expect(data.evidence.reason).toEqual(expect.any(String));
    // Its time is recorded, so the retry waits instead of spinning.
    expect(data.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('does not trust an exit code without matching evidence', async () => {
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner({ baseSha: SHA, exitCode: 0, stdout: 'all good, trust me' }).deps
    );
    expect(r.status).toBe('could-not-run');
    expect(db.campaignTarget.updateMany.mock.calls[0]?.[0].data.state).toBeUndefined();
  });

  it('treats a killed command as could-not-run', async () => {
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner({ baseSha: null, exitCode: null, stdout: '' }).deps
    );
    expect(r.status).toBe('could-not-run');
  });

  it('treats a sandbox that failed to start as could-not-run, with the credential masked', async () => {
    const run = vi.fn().mockRejectedValue(new Error(`clone failed for ghp_${'a'.repeat(36)}`));
    const r = await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, { run });
    expect(r).toMatchObject({ changed: false, status: 'could-not-run' });
    expect(r.reason).not.toContain('ghp_aaaa');
    expect(r.reason).toMatch(/could not run/);
  });

  it('treats an image the team does not allow as could-not-run', async () => {
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner({ baseSha: null, exitCode: null, refused: 'image not allowed', stdout: '' }).deps
    );
    expect(r.status).toBe('could-not-run');
    expect(r.reason).toMatch(/image not allowed/);
  });

  it('lets a cancellation through', async () => {
    const run = vi.fn().mockRejectedValue(new CancelledFailure('cancelled'));
    await expect(
      runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, { run })
    ).rejects.toBeInstanceOf(CancelledFailure);
  });

  it('writes nothing when a person moved the target meanwhile', async () => {
    db.campaignTarget.updateMany.mockResolvedValue({ count: 0 });
    const r = await runCampaignCheck(
      { campaignId: CAMPAIGN, targetId: TARGET },
      runner(SATISFIED_OUT).deps
    );
    expect(r).toMatchObject({ changed: false, state: 'MERGED' });
  });

  it('does not run for a paused campaign, a target that is not waiting, or a campaign without a recipe', async () => {
    const { deps, run } = runner(SATISFIED_OUT);
    db.campaign.findUnique.mockResolvedValueOnce({
      orgId: ORG,
      recipeParams: {},
      recipeRef: 'npm-dependency@2',
      state: 'PAUSED',
    });
    expect((await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps)).status).toBe(
      'skipped'
    );
    db.campaignTarget.findFirst.mockResolvedValueOnce({
      connectionId: 'conn-1',
      lastCheckedAt: null,
      regressions: 0,
      state: 'RUNNING',
      teamId: TEAM,
    });
    expect((await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps)).status).toBe(
      'skipped'
    );
    db.campaign.findUnique.mockResolvedValueOnce({
      orgId: ORG,
      recipeParams: null,
      recipeRef: null,
      state: 'ACTIVE',
    });
    expect((await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps)).status).toBe(
      'skipped'
    );
    expect(run).not.toHaveBeenCalled();
    expect(db.campaignTarget.updateMany).not.toHaveBeenCalled();
  });

  it('reads a recipe with no check (@1) as could-not-run, never as a verdict', async () => {
    db.campaign.findUnique.mockResolvedValue({
      orgId: ORG,
      recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
      recipeRef: 'npm-dependency@1',
      state: 'ACTIVE',
    });
    const { deps, run } = runner(SATISFIED_OUT);
    const r = await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, deps);
    expect(r.status).toBe('could-not-run');
    expect(run).not.toHaveBeenCalled();
  });

  it('reads the target under the campaign’s tenant', async () => {
    await runCampaignCheck({ campaignId: CAMPAIGN, targetId: TARGET }, runner(SATISFIED_OUT).deps);
    expect(db.campaignTarget.findFirst.mock.calls[0]?.[0].where).toEqual({
      campaign: { orgId: ORG },
      campaignId: CAMPAIGN,
      id: TARGET,
    });
  });
});

describe('discoverCampaignTargets', () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    launchedById: 'user-1',
    orgId: ORG,
    recipeParams: { packageName: 'lodash', targetVersion: '4.17.21' },
    recipeRef: 'npm-dependency@2',
    scopeId: TEAM,
    scopeKind: 'TEAM',
    state: 'ACTIVE',
    ...over,
  });
  const repo = (id: string, teamId = TEAM) => ({
    id,
    organizationName: 'acme',
    repoName: id,
    teamId,
  });

  beforeEach(() => {
    db.campaign.findUnique.mockResolvedValue(campaign());
    db.user.findUnique.mockResolvedValue({ isActive: true, role: 'USER' });
    db.campaignTarget.findMany.mockResolvedValue([]);
    db.campaignProposal.findMany.mockResolvedValue([]);
    db.campaignDiscoveryCheck.findMany.mockResolvedValue([]);
    db.campaignDiscoveryCheck.deleteMany.mockResolvedValue({ count: 1 });
    db.campaignDiscoveryCheck.upsert.mockResolvedValue({});
    db.connection.findMany.mockResolvedValue([]);
    perms.can.mockResolvedValue({ allowed: true });
  });

  it('returns the unsatisfied repositories of the scope it has not seen, and drops satisfied ones', async () => {
    db.connection.findMany.mockResolvedValue([repo('a'), repo('b'), repo('c')]);
    db.campaignTarget.findMany.mockResolvedValue([{ connectionId: 'a' }]);
    const run = vi
      .fn()
      .mockResolvedValueOnce(NOT_SATISFIED_OUT)
      .mockResolvedValueOnce(SATISFIED_OUT);
    const r = await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, { run });
    // `a` is already a target (never checked); `b` is unsatisfied; `c` is satisfied.
    expect(run).toHaveBeenCalledTimes(2);
    expect(r.candidates).toEqual([
      {
        connectionId: 'b',
        label: 'acme/b',
        reachable: true,
        satisfied: false,
        teamId: TEAM,
      },
    ]);
    expect(r.nextCursor).toBeNull();
  });

  it('reports a repository the launcher may not start work in as unreachable, with the reason', async () => {
    db.connection.findMany.mockResolvedValue([repo('a', 'team-x')]);
    perms.can.mockResolvedValue({ allowed: false });
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0 },
      runner(NOT_SATISFIED_OUT).deps
    );
    expect(r.candidates[0]).toMatchObject({
      reachable: false,
      unreachableReason: 'the launcher does not lead the team that owns the repository',
    });
  });

  it('reports a team with campaigns turned off as unreachable', async () => {
    db.connection.findMany.mockResolvedValue([repo('a', 'team-off')]);
    enabled.off.add('team-off');
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0 },
      runner(NOT_SATISFIED_OUT).deps
    );
    expect(r.candidates[0]).toMatchObject({ reachable: false });
    expect(r.candidates[0]?.unreachableReason).toMatch(/not enabled/);
  });

  it('reports a check that could not run as unchecked, neither satisfied nor not', async () => {
    db.connection.findMany.mockResolvedValue([repo('a')]);
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0 },
      runner({ baseSha: null, exitCode: 3, stdout: '' }).deps
    );
    expect(r.candidates[0]).toMatchObject({ connectionId: 'a', satisfied: null });
  });

  it('limits a team scope to that team and the repositories the launcher may see', async () => {
    await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, runner(SATISFIED_OUT).deps);
    const arg = db.connection.findMany.mock.calls[0]?.[0];
    expect(arg.where).toMatchObject({
      isActive: true,
      team: { isActive: true, orgId: ORG },
      teamId: TEAM,
      type: 'git_repo',
    });
    // A member's view: the owning team or a team it is shared with.
    expect(JSON.stringify(arg.where.OR)).toContain('user-1');
    expect(arg.orderBy).toEqual({ id: 'asc' });
  });

  it('walks an organization scope without the membership filter for an admin', async () => {
    db.campaign.findUnique.mockResolvedValue(campaign({ scopeId: null, scopeKind: 'ORG' }));
    db.user.findUnique.mockResolvedValue({ isActive: true, role: 'ADMIN' });
    await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, runner(SATISFIED_OUT).deps);
    const where = db.connection.findMany.mock.calls[0]?.[0].where;
    expect(where.team).toEqual({ isActive: true, orgId: ORG });
    expect(where.teamId).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it('hands back a cursor while the scope has more, and resumes from it', async () => {
    const full = Array.from({ length: DISCOVERY_CHUNK }, (_, i) => repo(`r${i}`));
    db.connection.findMany.mockResolvedValue(full);
    const run = vi.fn().mockResolvedValue(SATISFIED_OUT);
    const r = await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 50 }, { run });
    expect(r.nextCursor).toBe(50 + DISCOVERY_CHUNK);
    expect(db.connection.findMany.mock.calls[0]?.[0]).toMatchObject({
      skip: 50,
      take: DISCOVERY_CHUNK,
    });
  });

  it('stops right after the candidate that reaches maxCandidates, with the cursor just past it', async () => {
    db.connection.findMany.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map((id) => repo(id)));
    const { deps, run } = runner(NOT_SATISFIED_OUT);
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 100, maxCandidates: 2 },
      deps
    );
    expect(r.candidates.map((c) => c.connectionId)).toEqual(['a', 'b']);
    expect(run).toHaveBeenCalledTimes(2);
    // The walk resumes at `c`, not at the end of the chunk.
    expect(r.nextCursor).toBe(102);
  });

  it('counts a satisfied repository toward the cursor but not toward the candidates', async () => {
    db.connection.findMany.mockResolvedValue(['a', 'b', 'c'].map((id) => repo(id)));
    const run = vi
      .fn()
      .mockResolvedValueOnce(SATISFIED_OUT)
      .mockResolvedValueOnce(NOT_SATISFIED_OUT)
      .mockResolvedValueOnce(NOT_SATISFIED_OUT);
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0, maxCandidates: 1 },
      { run }
    );
    expect(r.candidates.map((c) => c.connectionId)).toEqual(['b']);
    expect(r.nextCursor).toBe(2);
  });

  it('honours a smaller limit than a chunk', async () => {
    db.connection.findMany.mockResolvedValue([repo('a'), repo('b')]);
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0, limit: 2 },
      runner(SATISFIED_OUT).deps
    );
    expect(db.connection.findMany.mock.calls[0]?.[0].take).toBe(2);
    // A full page of what was asked for: the scope may go on.
    expect(r.nextCursor).toBe(2);
  });

  it('starts no repository whose worst case no longer fits the activity timeout, and resumes there', async () => {
    // npm-dependency@2: a 10 minute check and a 5 minute clone allowance is 15 minutes worst case,
    // against a 30 minute activity less its 2 minute margin. Each repository here takes 6 minutes.
    db.connection.findMany.mockResolvedValue(
      Array.from({ length: DISCOVERY_CHUNK }, (_, i) => repo(`r${i}`))
    );
    let clock = 0;
    const run = vi.fn(async () => {
      clock += 6 * 60_000;
      return NOT_SATISFIED_OUT;
    });
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0 },
      { now: () => clock, run }
    );
    // Started at 0, 6 and 12 minutes (12 + 15 = 27 fits 28); at 18 minutes it would not.
    expect(run).toHaveBeenCalledTimes(3);
    expect(r.candidates).toHaveLength(3);
    expect(r.nextCursor).toBe(3);
  });

  it('always checks the first repository, whatever a check may cost', async () => {
    db.connection.findMany.mockResolvedValue([repo('a'), repo('b')]);
    let clock = 0;
    const run = vi.fn(async () => {
      clock += 40 * 60_000;
      return NOT_SATISFIED_OUT;
    });
    const r = await discoverCampaignTargets(
      { campaignId: CAMPAIGN, cursor: 0 },
      { now: () => clock, run }
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.nextCursor).toBe(1);
  });

  it('clones neither a repository that is already a target in any state nor a recorded proposal', async () => {
    db.connection.findMany.mockResolvedValue([repo('sat'), repo('prop'), repo('new')]);
    // A SATISFIED target is still a target: its rescan is the check activity's, not discovery's.
    db.campaignTarget.findMany.mockResolvedValue([{ connectionId: 'sat' }]);
    db.campaignProposal.findMany.mockResolvedValue([{ connectionId: 'prop' }]);
    const { deps, run } = runner(NOT_SATISFIED_OUT);
    const r = await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, deps);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].repoId).toBe('new');
    expect(r.candidates.map((c) => c.connectionId)).toEqual(['new']);
  });

  describe('the satisfied marker', () => {
    const tipOf = (sha: string | null) => vi.fn().mockResolvedValue(sha);

    it('records a marker for a non-target repository that checks satisfied', async () => {
      db.connection.findMany.mockResolvedValue([repo('c')]);
      const { deps } = runner(SATISFIED_OUT);
      await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, deps);
      expect(db.campaignDiscoveryCheck.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: { baseSha: SHA, campaignId: CAMPAIGN, connectionId: 'c' },
          where: { campaignId_connectionId: { campaignId: CAMPAIGN, connectionId: 'c' } },
        })
      );
    });

    it('skips an unchanged marked repository without cloning it, and still advances the cursor', async () => {
      db.connection.findMany.mockResolvedValue([repo('m'), repo('n')]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([{ baseSha: SHA, connectionId: 'm' }]);
      const run = vi.fn().mockResolvedValue(NOT_SATISFIED_OUT);
      const resolveTip = tipOf(SHA);
      const r = await discoverCampaignTargets(
        { campaignId: CAMPAIGN, cursor: 0, limit: 2 },
        { resolveTip, run }
      );
      expect(resolveTip).toHaveBeenCalledWith('m');
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0].repoId).toBe('n');
      expect(r.candidates.map((c) => c.connectionId)).toEqual(['n']);
      expect(r.nextCursor).toBe(2);
    });

    it('does not count a marker skip toward maxCandidates', async () => {
      db.connection.findMany.mockResolvedValue([repo('m'), repo('n'), repo('o')]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([{ baseSha: SHA, connectionId: 'm' }]);
      const r = await discoverCampaignTargets(
        { campaignId: CAMPAIGN, cursor: 0, maxCandidates: 2 },
        { resolveTip: tipOf(SHA), run: vi.fn().mockResolvedValue(NOT_SATISFIED_OUT) }
      );
      expect(r.candidates.map((c) => c.connectionId)).toEqual(['n', 'o']);
    });

    it('re-checks a marked repository whose base moved, and refreshes the marker when still satisfied', async () => {
      const moved = 'c'.repeat(40);
      db.connection.findMany.mockResolvedValue([repo('m')]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([{ baseSha: moved, connectionId: 'm' }]);
      const { run } = runner(SATISFIED_OUT);
      await discoverCampaignTargets(
        { campaignId: CAMPAIGN, cursor: 0 },
        { resolveTip: tipOf(SHA), run }
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(db.campaignDiscoveryCheck.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ baseSha: SHA }) })
      );
    });

    it('checks normally, fail-closed, when the tip cannot be resolved', async () => {
      db.connection.findMany.mockResolvedValue([repo('m')]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([{ baseSha: SHA, connectionId: 'm' }]);
      for (const resolveTip of [tipOf(null), vi.fn().mockRejectedValue(new Error('host down'))]) {
        const run = vi.fn().mockResolvedValue(NOT_SATISFIED_OUT);
        await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, { resolveTip, run });
        expect(run).toHaveBeenCalledTimes(1);
      }
    });

    it('deletes the marker when a re-check is not satisfied', async () => {
      db.connection.findMany.mockResolvedValue([repo('m')]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([
        { baseSha: 'c'.repeat(40), connectionId: 'm' },
      ]);
      await discoverCampaignTargets(
        { campaignId: CAMPAIGN, cursor: 0 },
        { resolveTip: tipOf(SHA), run: vi.fn().mockResolvedValue(NOT_SATISFIED_OUT) }
      );
      expect(db.campaignDiscoveryCheck.deleteMany).toHaveBeenCalledWith({
        where: { campaign: { orgId: ORG }, campaignId: CAMPAIGN, connectionId: 'm' },
      });
    });

    it('deletes the marker of a repository that has become a target', async () => {
      db.connection.findMany.mockResolvedValue([repo('m')]);
      db.campaignTarget.findMany.mockResolvedValue([{ connectionId: 'm' }]);
      db.campaignDiscoveryCheck.findMany.mockResolvedValue([{ baseSha: SHA, connectionId: 'm' }]);
      const { deps, run } = runner(NOT_SATISFIED_OUT);
      await discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, deps);
      expect(run).not.toHaveBeenCalled();
      expect(db.campaignDiscoveryCheck.deleteMany).toHaveBeenCalledTimes(1);
    });
  });

  it('finds nothing for a campaign with no scope, no check, no launcher or a deactivated one', async () => {
    const { deps, run } = runner(NOT_SATISFIED_OUT);
    for (const over of [
      { scopeKind: null },
      { recipeRef: 'npm-dependency@1' },
      { launchedById: null },
      { state: 'PAUSED' },
    ]) {
      db.campaign.findUnique.mockResolvedValueOnce(campaign(over));
      await expect(
        discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, deps)
      ).resolves.toEqual({ candidates: [], nextCursor: null });
    }
    db.user.findUnique.mockResolvedValueOnce({ isActive: false, role: 'USER' });
    await expect(
      discoverCampaignTargets({ campaignId: CAMPAIGN, cursor: 0 }, deps)
    ).resolves.toEqual({ candidates: [], nextCursor: null });
    expect(run).not.toHaveBeenCalled();
    expect(db.connection.findMany).not.toHaveBeenCalled();
  });
});
