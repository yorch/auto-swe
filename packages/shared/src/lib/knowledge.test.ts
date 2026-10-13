import { describe, expect, it } from 'vitest';
import {
  canApproveKnowledge,
  knowledgeReadableWhere,
  toKnowledgeScalarProjection,
} from './knowledge.js';

describe('knowledge policy', () => {
  it('keeps repository-origin unreviewed learning local to the originating repository', () => {
    const where = knowledgeReadableWhere({
      isPlatformAdmin: false,
      orgIds: ['org-1'],
      repoIds: ['repo-1'],
      teamIds: ['team-1'],
      userId: 'user-1',
    });
    const branches = where.OR as Array<Record<string, unknown>>;
    expect(branches).toContainEqual(
      expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({ repoId: { in: ['repo-1'] }, repository: expect.any(Object) }),
        ]),
      })
    );
    expect(branches).toContainEqual({
      AND: [
        { originTeamId: { in: ['team-1'] }, repoId: null, visibility: 'REPOSITORY' },
        { OR: [{ status: 'APPROVED' }, { status: 'UNREVIEWED', type: 'LEARNING' }] },
      ],
    });
    expect(branches).not.toContainEqual(
      expect.objectContaining({ orgId: { in: ['org-1'] }, status: 'UNREVIEWED' })
    );
  });

  it('does not grant platform admins private repository-local reads without a capability but retains published summaries', () => {
    const branches = knowledgeReadableWhere({
      isPlatformAdmin: true,
      orgIds: ['org-1'],
      repoIds: [],
      teamIds: ['team-1'],
      userId: 'admin',
    }).OR as Array<Record<string, unknown>>;
    expect(branches.some((branch) => JSON.stringify(branch).includes('repository'))).toBe(false);
    expect(branches).toContainEqual({
      ownerTeamId: 'team-1',
      status: 'APPROVED',
      visibility: 'TEAM',
    });
    expect(branches).toContainEqual({
      orgId: 'org-1',
      status: 'APPROVED',
      visibility: 'ORGANIZATION',
    });
  });

  it('keeps unreviewed curated policy out of ordinary retrieval, including platform admins', () => {
    expect(
      knowledgeReadableWhere({
        isPlatformAdmin: true,
        orgIds: [],
        repoIds: [],
        teamIds: [],
        userId: 'admin-1',
      })
    ).toEqual({ OR: [] });
  });

  it('requires approved state for team, selected-team and organization visibility', () => {
    const branches = knowledgeReadableWhere({
      isPlatformAdmin: false,
      orgIds: ['org-1'],
      repoIds: [],
      teamIds: ['team-2'],
      userId: 'user-2',
    }).OR as Array<Record<string, unknown>>;
    expect(branches).toContainEqual({
      ownerTeamId: { in: ['team-2'] },
      status: 'APPROVED',
      visibility: 'TEAM',
    });
    const selectedTeamGrant = {
      grants: { some: { teamId: { in: ['team-2'] } } },
      status: 'APPROVED',
      visibility: 'SELECTED_TEAMS',
    };
    expect(branches).toContainEqual(selectedTeamGrant);
    const elevatedBranches = knowledgeReadableWhere({
      isPlatformAdmin: true,
      orgIds: ['org-1'],
      repoIds: [],
      teamIds: ['team-2'],
      userId: 'user-2',
    }).OR as Array<Record<string, unknown>>;
    expect(elevatedBranches).toContainEqual(selectedTeamGrant);
    expect(branches).toContainEqual({
      orgId: { in: ['org-1'] },
      status: 'APPROVED',
      visibility: 'ORGANIZATION',
    });
    expect(canApproveKnowledge('LEAD', 'ORG_MEMBER', false, 'SELECTED_TEAMS')).toBe(true);
    expect(canApproveKnowledge('LEAD', 'ORG_MEMBER', false, 'ORGANIZATION')).toBe(false);
    expect(canApproveKnowledge('ENGINEER', 'ORG_ADMIN', false, 'ORGANIZATION')).toBe(true);
    expect(canApproveKnowledge(null, null, false, 'TEAM')).toBe(false);
    expect(canApproveKnowledge(null, null, true, 'ORGANIZATION')).toBe(true);
  });

  it('uses a valid impossible predicate when scope is missing', () => {
    expect(
      knowledgeReadableWhere({
        isPlatformAdmin: false,
        orgIds: [],
        repoIds: [],
        teamIds: [],
        userId: 'user-1',
      })
    ).toEqual({ id: { in: [] } });
  });

  it('projects no evidence, vectors, source ids, or tenant ids', () => {
    const projection = toKnowledgeScalarProjection({
      content: 'Reviewed content',
      createdAt: new Date(0),
      embedding: [1, 2],
      evidence: [{ reference: 'private-artifact' }],
      id: 'knowledge-1',
      originTeamId: 'team-1',
      ownerTeamId: 'team-1',
      repoId: 'repo-1',
      status: 'APPROVED',
      title: 'A title',
      type: 'LEARNING',
      version: 2,
      visibility: 'TEAM',
    } as never);
    for (const hidden of ['evidence', 'embedding', 'repoId', 'originTeamId', 'ownerTeamId']) {
      expect(projection).not.toHaveProperty(hidden);
    }
    expect(projection).toMatchObject({ content: 'Reviewed content', id: 'knowledge-1' });
  });
});
