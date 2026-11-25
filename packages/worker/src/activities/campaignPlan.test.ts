import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  campaign: { findUnique: vi.fn(), updateMany: vi.fn() },
  campaignTarget: { findMany: vi.fn(), updateMany: vi.fn() },
  connection: { findMany: vi.fn() },
}));
const planner = vi.hoisted(() => ({ decomposeEpic: vi.fn(), loadStoredUpstream: vi.fn() }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_why: string, _models: string[], fn: () => unknown) => fn(),
}));
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));
vi.mock('../agents/plannerAgent.js', () => ({ decomposeEpic: planner.decomposeEpic }));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/config/agentSkills.js', () => ({ loadAgentSkills: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({}),
}));
vi.mock('../lib/spendOwner.js', () => ({
  ownerOfTeam: vi.fn().mockResolvedValue({}),
  withSpendOwner: (_owner: Promise<unknown>, fn: () => unknown) => fn(),
}));
vi.mock('./planEpic.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./planEpic.js')>()),
  loadStoredUpstream: planner.loadStoredUpstream,
}));

import { cleanBrief, planCampaignBriefs, restrictToStoredEdges } from './campaignPlan.js';

const CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const ORG = '55555555-5555-4555-8555-555555555555';

describe('restrictToStoredEdges', () => {
  it('keeps only the planner’s edges that the dependency graph also holds', () => {
    const planned = [
      { dependsOn: [], repoId: 'lib' },
      { dependsOn: ['lib', 'tool'], repoId: 'api' },
      { dependsOn: ['api'], repoId: 'web' },
      { dependsOn: [], repoId: 'tool' },
    ];
    const stored = new Map([
      ['api', ['lib']],
      ['web', ['lib']],
    ]);
    expect(restrictToStoredEdges(planned, stored)).toEqual([
      { dependsOn: [], repoId: 'lib' },
      { dependsOn: ['lib'], repoId: 'api' },
      // web's graph edge points at lib, not at api, so the planner's guess is dropped.
      { dependsOn: [], repoId: 'web' },
      { dependsOn: [], repoId: 'tool' },
    ]);
  });

  it('adds no edge the planner did not choose, and none when the graph is empty', () => {
    const planned = [
      { dependsOn: [], repoId: 'a' },
      { dependsOn: [], repoId: 'b' },
    ];
    expect(restrictToStoredEdges(planned, new Map([['b', ['a']]]))).toEqual(planned);
    expect(
      restrictToStoredEdges([{ dependsOn: ['a'], repoId: 'b' }, ...planned.slice(0, 1)], new Map())
    ).toEqual([
      { dependsOn: [], repoId: 'b' },
      { dependsOn: [], repoId: 'a' },
    ]);
  });

  it('drops the edge that would close a cycle', () => {
    const planned = [
      { dependsOn: ['b'], repoId: 'a' },
      { dependsOn: ['a'], repoId: 'b' },
    ];
    const stored = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const out = restrictToStoredEdges(planned, stored);
    expect(out.reduce((n, e) => n + e.dependsOn.length, 0)).toBe(1);
  });
});

describe('cleanBrief', () => {
  it('strips control characters, bounds the text and never returns an empty brief', () => {
    expect(cleanBrief('a\u0000b\tc\nd\u0085e', 'fallback')).toBe('a b\tc\nd e');
    expect(cleanBrief('   ', 'fallback')).toBe('fallback');
    expect(cleanBrief('x'.repeat(20_000), 'fallback')).toHaveLength(8000);
  });
});

describe('planCampaignBriefs', () => {
  const targets = [
    { brief: null, connectionId: 'lib', id: 'tg-lib', teamId: 't1' },
    { brief: null, connectionId: 'api', id: 'tg-api', teamId: 't1' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    db.campaign.findUnique.mockResolvedValue({
      description: 'Migrate to the new client',
      orgId: ORG,
      ownerTeamId: 't1',
      plan: 'PLANNED',
      state: 'PLANNING',
    });
    db.campaignTarget.findMany.mockResolvedValue(targets);
    db.connection.findMany.mockResolvedValue([
      { description: 'the lib', id: 'lib', language: 'ts', repoName: 'lib', team: { orgId: ORG } },
      { description: 'the api', id: 'api', language: 'ts', repoName: 'api', team: { orgId: ORG } },
    ]);
    planner.decomposeEpic.mockResolvedValue([
      { dependsOn: [], description: 'Bump the client in lib', repoId: 'lib' },
      { dependsOn: ['lib'], description: 'Adapt the api to the new client', repoId: 'api' },
    ]);
    planner.loadStoredUpstream.mockResolvedValue(new Map([['api', ['lib']]]));
    db.campaignTarget.updateMany.mockResolvedValue({ count: 1 });
    db.campaign.updateMany.mockResolvedValue({ count: 1 });
    // An interactive transaction: the callback runs against the same mocked client.
    db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  });

  /** The target writes of the transaction, as [id, teamId, brief, dependsOn]. */
  const targetWrites = () =>
    db.campaignTarget.updateMany.mock.calls.map(([a]) => [
      a.where.id,
      a.where.teamId,
      a.data.brief,
      a.data.dependsOn,
    ]);

  it('writes a brief per target and the edges the graph confirms, as target ids, in one transaction', async () => {
    const r = await planCampaignBriefs({ campaignId: CAMPAIGN });
    expect(r).toEqual({ edges: 1, planned: 2 });
    expect(planner.decomposeEpic.mock.calls[0]?.[0]).toBe('Migrate to the new client');
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(targetWrites()).toEqual([
      ['tg-lib', 't1', 'Bump the client in lib', []],
      ['tg-api', 't1', 'Adapt the api to the new client', ['tg-lib']],
    ]);
    // The write is conditional on the campaign still being a PLANNING reconciler campaign.
    expect(db.campaign.updateMany.mock.calls[0]?.[0].where).toEqual({
      id: CAMPAIGN,
      orgId: ORG,
      state: 'PLANNING',
      workflowKind: 'RECONCILER',
    });
  });

  it('writes nothing when the campaign was cancelled or confirmed while the planner ran', async () => {
    db.campaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(planCampaignBriefs({ campaignId: CAMPAIGN })).resolves.toEqual({
      edges: 0,
      planned: 0,
    });
    expect(db.campaignTarget.updateMany).not.toHaveBeenCalled();
  });

  it('gives every target a brief, including one the planner omitted and one whose repository is gone', async () => {
    db.campaignTarget.findMany.mockResolvedValue([
      ...targets,
      { brief: null, connectionId: null, id: 'tg-gone', teamId: 't1' },
    ]);
    planner.decomposeEpic.mockResolvedValue([
      { dependsOn: [], description: 'Bump the client in lib', repoId: 'lib' },
    ]);
    const r = await planCampaignBriefs({ campaignId: CAMPAIGN });
    expect(r.planned).toBe(3);
    expect(targetWrites()).toEqual([
      ['tg-lib', 't1', 'Bump the client in lib', []],
      ['tg-api', 't1', 'Migrate to the new client', []],
      ['tg-gone', 't1', 'Migrate to the new client', []],
    ]);
    expect(targetWrites().every(([, , brief]) => typeof brief === 'string' && brief !== '')).toBe(
      true
    );
  });

  it('claims no order when the dependency graph cannot be read', async () => {
    planner.loadStoredUpstream.mockRejectedValue(new Error('graph unreadable'));
    const r = await planCampaignBriefs({ campaignId: CAMPAIGN });
    expect(r.edges).toBe(0);
  });

  it('falls back to the campaign’s own brief for a repository the planner left blank', async () => {
    planner.decomposeEpic.mockResolvedValue([{ dependsOn: [], description: '  ', repoId: 'lib' }]);
    await planCampaignBriefs({ campaignId: CAMPAIGN });
    expect(targetWrites().map(([, , brief]) => brief)).toEqual([
      'Migrate to the new client',
      'Migrate to the new client',
    ]);
  });

  it('does nothing for a campaign that is not planned, not planning, or already planned', async () => {
    db.campaign.findUnique.mockResolvedValueOnce({
      description: 'x',
      orgId: ORG,
      ownerTeamId: 't1',
      plan: 'UNIFORM',
      state: 'PLANNING',
    });
    await expect(planCampaignBriefs({ campaignId: CAMPAIGN })).resolves.toEqual({
      edges: 0,
      planned: 0,
    });
    db.campaign.findUnique.mockResolvedValueOnce({
      description: 'x',
      orgId: ORG,
      ownerTeamId: 't1',
      plan: 'PLANNED',
      state: 'ACTIVE',
    });
    await expect(planCampaignBriefs({ campaignId: CAMPAIGN })).resolves.toEqual({
      edges: 0,
      planned: 0,
    });
    db.campaignTarget.findMany.mockResolvedValueOnce(targets.map((t) => ({ ...t, brief: 'done' })));
    await expect(planCampaignBriefs({ campaignId: CAMPAIGN })).resolves.toEqual({
      edges: 0,
      planned: 2,
    });
    expect(planner.decomposeEpic).not.toHaveBeenCalled();
  });

  it('refuses, without retrying, a campaign with no repository to plan against', async () => {
    db.campaignTarget.findMany.mockResolvedValue([
      { brief: null, connectionId: null, id: 'tg', teamId: 't1' },
    ]);
    await expect(planCampaignBriefs({ campaignId: CAMPAIGN })).rejects.toMatchObject({
      nonRetryable: true,
      type: 'CAMPAIGN_PLAN_EMPTY',
    });
  });

  it('reads the targets under the campaign’s tenant', async () => {
    await planCampaignBriefs({ campaignId: CAMPAIGN });
    expect(db.campaignTarget.findMany.mock.calls[0]?.[0].where).toEqual({
      campaign: { orgId: ORG },
      campaignId: CAMPAIGN,
    });
  });
});
