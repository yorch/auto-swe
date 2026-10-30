import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ orgWideReportsEnabled: false }));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: async () => mocks.orgWideReportsEnabled,
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _tables: string[], callback: () => unknown) => callback(),
}));

import {
  resolveWorkflowRunAttributionScope,
  workflowRunAttributionWhere,
  workflowRunRollupAttributionWhere,
} from './workflowRunAttributionScope.js';

const USER = { role: 'ENGINEER', sub: 'user-1' };
const ORG = 'org-1';
const TEAM = 'team-1';
const REPO = 'repo-1';

function mockPrisma() {
  return {
    connection: { findMany: vi.fn().mockResolvedValue([{ id: REPO }]) },
    organizationMembership: {
      findMany: vi.fn().mockResolvedValue([{ orgId: ORG }]),
    },
    team: { findUnique: vi.fn().mockResolvedValue({ orgId: ORG }) },
    teamMembership: { findMany: vi.fn().mockResolvedValue([{ teamId: 'member-team' }]) },
  };
}

beforeEach(() => {
  mocks.orgWideReportsEnabled = false;
});

describe('workflow run attribution scope', () => {
  it('includes org attribution only when the organization setting is enabled', async () => {
    const prisma = mockPrisma();
    const disabled = await resolveWorkflowRunAttributionScope(prisma as never, USER, undefined);
    expect(disabled.orgIds).toEqual([]);
    expect(disabled.teamIds).toEqual(['member-team']);

    mocks.orgWideReportsEnabled = true;
    const enabled = await resolveWorkflowRunAttributionScope(prisma as never, USER, undefined);
    expect(enabled.orgIds).toEqual([ORG]);
    expect(enabled).toMatchObject({ repoIds: [REPO], userId: USER.sub });
  });

  it('authorizes a non-member team filter only through its enabled organization', async () => {
    const prisma = mockPrisma();
    const disabled = await resolveWorkflowRunAttributionScope(
      prisma as never,
      USER,
      undefined,
      TEAM
    );
    expect(disabled.authorized).toBe(false);
    mocks.orgWideReportsEnabled = true;
    const enabled = await resolveWorkflowRunAttributionScope(
      prisma as never,
      USER,
      undefined,
      TEAM
    );
    expect(enabled.authorized).toBe(true);
    expect(workflowRunAttributionWhere(enabled)).toEqual({ attributedTeamId: TEAM });
    expect(workflowRunRollupAttributionWhere(enabled)).toEqual({ teamId: TEAM });
  });

  it('uses one OR across teams, enabled organizations, reachable repositories and launcher', () => {
    const scope = {
      authorized: true,
      isAdmin: false,
      orgIds: [ORG],
      repoIds: [REPO],
      teamIds: ['member-team'],
      userId: USER.sub,
    };
    const live = workflowRunAttributionWhere(scope);
    const rollup = workflowRunRollupAttributionWhere(scope);
    expect(live.OR).toEqual(
      expect.arrayContaining([
        { attributedTeamId: { in: ['member-team'] } },
        { attributedOrgId: { in: [ORG] } },
        { attributedRepoId: { in: [REPO] } },
        { launchedById: USER.sub },
      ])
    );
    expect(rollup.OR).toEqual([
      { teamId: { in: ['member-team'] } },
      { orgId: { in: [ORG] } },
      { repoId: { in: [REPO] } },
      { launchedById: USER.sub },
    ]);
    const liveRows = [
      {
        attributedOrgId: null,
        attributedRepoId: null,
        attributedTeamId: null,
        id: 'launched-only',
        launchedById: USER.sub,
      },
      {
        attributedOrgId: null,
        attributedRepoId: REPO,
        attributedTeamId: null,
        id: 'repo-only',
        launchedById: null,
      },
      {
        attributedOrgId: null,
        attributedRepoId: REPO,
        attributedTeamId: null,
        id: 'shared-match',
        launchedById: USER.sub,
      },
    ];
    const liveVisible = liveRows.filter((row) =>
      live.OR?.some((term) => {
        const repoFilter = term.attributedRepoId;
        const repoIds =
          typeof repoFilter === 'object' && repoFilter !== null && 'in' in repoFilter
            ? repoFilter.in
            : null;
        return (
          term.launchedById === row.launchedById ||
          (Array.isArray(repoIds) && repoIds.includes(row.attributedRepoId ?? ''))
        );
      })
    );
    expect(liveVisible.map(({ id }) => id)).toEqual(['launched-only', 'repo-only', 'shared-match']);

    const rows = [
      { id: 'launched-only', launchedById: USER.sub },
      { id: 'repo-only', repoId: REPO },
      { id: 'shared-match', launchedById: USER.sub, repoId: REPO },
    ];
    const visible = rows.filter((row) =>
      rollup.OR?.some(
        (term) =>
          ('launchedById' in term && term.launchedById === row.launchedById) ||
          ('repoId' in term && term.repoId?.in?.includes(row.repoId ?? ''))
      )
    );
    expect(visible.map(({ id }) => id)).toEqual(['launched-only', 'repo-only', 'shared-match']);
  });
});
