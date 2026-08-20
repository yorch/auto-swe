import { describe, expect, it, vi } from 'vitest';
import { resolveRepoDependencyContext } from './repoDependencyResolver.js';

const ORG = 'org-1';

/** A prisma double with just the two model accessors the resolver uses. */
function mockPrisma(edges: {
  upstream?: unknown[];
  downstream?: unknown[];
  neighbors?: unknown[];
}) {
  const repoDependency = { findMany: vi.fn() };
  repoDependency.findMany
    .mockResolvedValueOnce(edges.upstream ?? [])
    .mockResolvedValueOnce(edges.downstream ?? []);
  const connection = { findMany: vi.fn().mockResolvedValue(edges.neighbors ?? []) };
  return { connection, repoDependency } as never;
}

const neighbor = (id: string) => ({
  id,
  name: null,
  organizationName: 'acme',
  repoName: id,
  teamId: 'team-x',
});

describe('resolveRepoDependencyContext', () => {
  it('no-ops (empty) when repoId is absent', async () => {
    const prisma = mockPrisma({});
    await expect(resolveRepoDependencyContext(prisma, null, { orgId: ORG })).resolves.toEqual({
      downstream: [],
      upstream: [],
    });
    await expect(resolveRepoDependencyContext(prisma, undefined, { orgId: ORG })).resolves.toEqual({
      downstream: [],
      upstream: [],
    });
    // No queries issued for the empty path.
    expect(
      (prisma as unknown as { connection: { findMany: ReturnType<typeof vi.fn> } }).connection
        .findMany
    ).not.toHaveBeenCalled();
  });

  it('walks both directions and hydrates visible neighbours', async () => {
    const prisma = mockPrisma({
      downstream: [{ confidence: 1, fromRepoId: 'api', id: 'e2', kind: 'code', source: 'manual' }],
      neighbors: [neighbor('sdk'), neighbor('api')],
      upstream: [{ confidence: 1, id: 'e1', kind: 'code', source: 'manual', toRepoId: 'sdk' }],
    });

    const out = await resolveRepoDependencyContext(prisma, 'me', { orgId: ORG });

    expect(out.upstream).toHaveLength(1);
    expect(out.upstream[0].repo.id).toBe('sdk');
    expect(out.upstream[0].edgeIds).toEqual(['e1']);
    expect(out.downstream).toHaveLength(1);
    expect(out.downstream[0].repo.id).toBe('api');
  });

  it('collapses multiple edges for one neighbour to max confidence + distinct kinds/sources', async () => {
    const prisma = mockPrisma({
      neighbors: [neighbor('sdk')],
      upstream: [
        { confidence: 0.6, id: 'e1', kind: 'code', source: 'inferred', toRepoId: 'sdk' },
        { confidence: 1, id: 'e2', kind: 'build', source: 'manual', toRepoId: 'sdk' },
      ],
    });

    const out = await resolveRepoDependencyContext(prisma, 'me', { orgId: ORG });

    expect(out.upstream).toHaveLength(1);
    expect(out.upstream[0].confidence).toBe(1);
    expect(out.upstream[0].kinds.sort()).toEqual(['build', 'code']);
    expect(out.upstream[0].sources.sort()).toEqual(['inferred', 'manual']);
    expect(out.upstream[0].edgeIds.sort()).toEqual(['e1', 'e2']);
  });

  it('drops a neighbour the visibility filter excluded (out of org / inactive)', async () => {
    const prisma = mockPrisma({
      // connection.findMany returns nothing → the edge points at an invisible repo.
      neighbors: [],
      upstream: [{ confidence: 1, id: 'e1', kind: 'code', source: 'manual', toRepoId: 'secret' }],
    });

    const out = await resolveRepoDependencyContext(prisma, 'me', { orgId: ORG });
    expect(out.upstream).toEqual([]);
  });

  it('filters edges to status=active and scopes neighbours to the caller org', async () => {
    const prisma = mockPrisma({ neighbors: [] });
    await resolveRepoDependencyContext(prisma, 'me', { orgId: ORG });

    const dep = (prisma as unknown as { repoDependency: { findMany: ReturnType<typeof vi.fn> } })
      .repoDependency;
    expect(dep.findMany.mock.calls[0][0].where).toMatchObject({
      fromRepoId: 'me',
      status: 'active',
    });
    expect(dep.findMany.mock.calls[1][0].where).toMatchObject({ status: 'active', toRepoId: 'me' });
  });
});
