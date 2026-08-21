import type { RepoDependencyNeighbor } from '@auto-swe/shared/lib/repoDependencyResolver';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cloneMock, credentialsMock, prismaMock } = vi.hoisted(() => ({
  cloneMock: vi.fn(),
  credentialsMock: vi.fn(),
  prismaMock: {
    connection: { findMany: vi.fn(), findUnique: vi.fn() },
    repoDependency: { findMany: vi.fn() },
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: prismaMock }));

vi.mock('../activities/workspace.js', () => ({
  cloneDependencyRepos: cloneMock,
}));

vi.mock('./scm/index.js', () => ({
  getScmProvider: () => ({ cloneCredentials: credentialsMock }),
  toRepoRef: (r: { organizationName: string | null; repoName: string | null }) => {
    if (!r.organizationName || !r.repoName) {
      throw new Error('not a git repo');
    }
    return { organizationName: r.organizationName, repoName: r.repoName };
  },
}));

import {
  checkoutUpstreamRepos,
  formatRepoDependencyContext,
  loadRepoDependencyContext,
  MAX_CROSS_REPO_NEIGHBORS,
  repoLabel,
  wantsCrossRepoCheckout,
  wantsCrossRepoContext,
} from './repoDependencyContext.js';

function neighbor(org: string, name: string, over: Partial<RepoDependencyNeighbor> = {}) {
  return {
    confidence: 1,
    edgeIds: [`e-${name}`],
    kinds: ['code'],
    repo: {
      id: `id-${name}`,
      name: `${org}/${name}`,
      organizationName: org,
      repoName: name,
      teamId: 't1',
    },
    sources: ['manual'],
    ...over,
  } satisfies RepoDependencyNeighbor;
}

beforeEach(() => {
  vi.clearAllMocks();
  cloneMock.mockResolvedValue([]);
  credentialsMock.mockResolvedValue({ authedCloneUrl: 'https://x:tok@github.com/acme/api.git' });
  // The checkout tier reads the subject repo's team to decide whether a
  // neighbour needs both-teams consent before its source may be cloned.
  prismaMock.connection.findUnique.mockResolvedValue({ teamId: 't1' });
});

describe('repoLabel', () => {
  it('prefers org/repo', () => {
    expect(repoLabel(neighbor('acme', 'api').repo)).toBe('acme/api');
  });

  it('falls back through repoName, name, then id', () => {
    expect(repoLabel({ id: 'i', name: 'n', organizationName: null, repoName: 'r' })).toBe('r');
    expect(repoLabel({ id: 'i', name: 'n', organizationName: null, repoName: null })).toBe('n');
    expect(repoLabel({ id: 'i', name: null, organizationName: null, repoName: null })).toBe('i');
  });
});

describe('formatRepoDependencyContext', () => {
  it('returns empty string when there are no neighbours', () => {
    expect(formatRepoDependencyContext({ downstream: [], upstream: [] })).toBe('');
  });

  it('opens with a single blank-line-prefixed markdown heading', () => {
    const out = formatRepoDependencyContext({
      downstream: [],
      upstream: [neighbor('acme', 'api')],
    });
    expect(out.startsWith('\n\n## Cross-Repo Dependency Context')).toBe(true);
  });

  it('renders each upstream neighbour as org/repo plus its kinds', () => {
    const out = formatRepoDependencyContext({
      downstream: [],
      upstream: [neighbor('acme', 'api', { kinds: ['code', 'build'] })],
    });
    expect(out).toContain('- acme/api — kinds: build, code');
  });

  it('frames upstream as contracts to honour and omits the downstream section', () => {
    const out = formatRepoDependencyContext({
      downstream: [],
      upstream: [neighbor('acme', 'api')],
    });
    expect(out).toContain('### Upstream — contracts this change must honour');
    expect(out).not.toContain('### Downstream');
  });

  it('frames downstream as blast radius and omits the upstream section', () => {
    const out = formatRepoDependencyContext({
      downstream: [neighbor('acme', 'web')],
      upstream: [],
    });
    expect(out).toContain('### Downstream — repos that consume this one');
    expect(out).toContain('blast radius');
    expect(out).not.toContain('### Upstream');
  });

  it('renders both directions with different framing', () => {
    const out = formatRepoDependencyContext({
      downstream: [neighbor('acme', 'web')],
      upstream: [neighbor('acme', 'api')],
    });
    expect(out).toContain('### Upstream — contracts this change must honour');
    expect(out).toContain('### Downstream — repos that consume this one');
    expect(out.indexOf('### Upstream')).toBeLessThan(out.indexOf('### Downstream'));
  });

  it('caps each direction and notes how many were hidden', () => {
    const many = Array.from({ length: MAX_CROSS_REPO_NEIGHBORS + 3 }, (_, i) =>
      neighbor('acme', `svc-${i}`)
    );
    const out = formatRepoDependencyContext({ downstream: many, upstream: many });
    const bullets = out.split('\n').filter((l) => l.startsWith('- acme/'));
    expect(bullets).toHaveLength(MAX_CROSS_REPO_NEIGHBORS * 2);
    expect(out).toContain('…+3 more upstream repos (not shown)');
    expect(out).toContain('…+3 more downstream repos (not shown)');
  });

  it('truncates the weakest edges first', () => {
    const weak = Array.from({ length: MAX_CROSS_REPO_NEIGHBORS }, (_, i) =>
      neighbor('acme', `weak-${i}`, { confidence: 0.2 })
    );
    const strong = neighbor('acme', 'strong', { confidence: 0.99 });
    const out = formatRepoDependencyContext({ downstream: [], upstream: [...weak, strong] });
    expect(out).toContain('- acme/strong');
    expect(out).toContain('…+1 more upstream repos (not shown)');
  });
});

describe('wantsCrossRepoContext / wantsCrossRepoCheckout', () => {
  it('defaults context ON and checkout OFF', () => {
    expect(wantsCrossRepoContext(undefined)).toBe(true);
    expect(wantsCrossRepoContext({})).toBe(true);
    expect(wantsCrossRepoCheckout(undefined)).toBe(false);
    expect(wantsCrossRepoCheckout({})).toBe(false);
  });

  it('honours explicit opt-out and opt-in', () => {
    expect(wantsCrossRepoContext({ crossRepoContext: false })).toBe(false);
    expect(wantsCrossRepoCheckout({ crossRepoCheckout: true })).toBe(true);
  });
});

describe('loadRepoDependencyContext', () => {
  function stubGraph() {
    prismaMock.repoDependency.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.fromRepoId
          ? [{ confidence: 1, id: 'e1', kind: 'code', source: 'manual', toRepoId: 'up-1' }]
          : [{ confidence: 1, fromRepoId: 'down-1', id: 'e2', kind: 'build', source: 'manifest' }]
    );
    prismaMock.connection.findMany.mockResolvedValue([
      { id: 'up-1', name: null, organizationName: 'acme', repoName: 'api', teamId: 't1' },
      { id: 'down-1', name: null, organizationName: 'acme', repoName: 'web', teamId: 't1' },
    ]);
  }

  it('returns empty without a repoId', async () => {
    expect(await loadRepoDependencyContext(null, 'org-1')).toBe('');
    expect(prismaMock.repoDependency.findMany).not.toHaveBeenCalled();
  });

  it('returns empty without an orgId — the graph is org-scoped', async () => {
    expect(await loadRepoDependencyContext('repo-1', undefined)).toBe('');
    expect(prismaMock.repoDependency.findMany).not.toHaveBeenCalled();
  });

  it('formats the resolved graph', async () => {
    stubGraph();
    const out = await loadRepoDependencyContext('repo-1', 'org-1');
    expect(out).toContain('- acme/api — kinds: code');
    expect(out).toContain('- acme/web — kinds: build');
  });

  it('swallows resolver errors and returns empty', async () => {
    prismaMock.repoDependency.findMany.mockRejectedValue(new Error('db down'));
    await expect(loadRepoDependencyContext('repo-1', 'org-1')).resolves.toBe('');
  });

  it('swallows a neighbour-hydration failure and returns empty', async () => {
    prismaMock.repoDependency.findMany.mockResolvedValue([
      { confidence: 1, id: 'e1', kind: 'code', source: 'manual', toRepoId: 'up-1' },
    ]);
    prismaMock.connection.findMany.mockRejectedValue(new Error('db down'));
    await expect(loadRepoDependencyContext('repo-1', 'org-1')).resolves.toBe('');
  });
});

describe('checkoutUpstreamRepos', () => {
  const workspace = { exec: vi.fn() };

  function stubUpstream(count: number) {
    prismaMock.repoDependency.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.fromRepoId
          ? Array.from({ length: count }, (_, i) => ({
              confidence: 1,
              id: `e${i}`,
              kind: 'code',
              source: 'manual',
              toRepoId: `up-${i}`,
            }))
          : []
    );
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `up-${i}`,
      name: null,
      organizationName: 'acme',
      repoName: `svc-${i}`,
      teamId: 't1',
    }));
    prismaMock.connection.findMany.mockImplementation(async ({ select }: { select: object }) =>
      'defaultBranch' in select
        ? rows.map((r) => ({ ...r, defaultBranch: 'main', githubApiUrl: null, githubUrl: null }))
        : rows
    );
  }

  it('no-ops without ids', async () => {
    expect(await checkoutUpstreamRepos(workspace, null, 'org-1')).toBe('');
    expect(await checkoutUpstreamRepos(workspace, 'repo-1', null)).toBe('');
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('returns empty when the repo has no upstream neighbours', async () => {
    stubUpstream(0);
    expect(await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1')).toBe('');
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('scopes the connection re-read to the org and only git repos', async () => {
    stubUpstream(1);
    await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1');
    const call = prismaMock.connection.findMany.mock.calls.at(-1)?.[0];
    expect(call.where).toMatchObject({
      isActive: true,
      team: { orgId: 'org-1' },
      type: 'git_repo',
    });
  });

  it("will not clone another team's repo on a detector-created edge", async () => {
    // Reading a neighbour's *name* in a prompt is cheap and consented-by-org;
    // copying its source onto disk is not. A manifest edge needs no sign-off
    // from the depended-upon team, so it must not unlock a cross-team checkout.
    prismaMock.repoDependency.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.fromRepoId
          ? [{ confidence: 1, id: 'e0', kind: 'code', source: 'manifest', toRepoId: 'up-0' }]
          : []
    );
    prismaMock.connection.findMany.mockResolvedValue([
      { id: 'up-0', name: null, organizationName: 'acme', repoName: 'svc-0', teamId: 'other-team' },
    ]);

    expect(await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1')).toBe('');
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it("clones another team's repo when a human agreed the edge (manual source)", async () => {
    stubUpstream(1);
    prismaMock.connection.findUnique.mockResolvedValue({ teamId: 'subject-team' });
    cloneMock.mockResolvedValue([{ label: 'acme-svc-0', path: '/workspace/deps/acme-svc-0' }]);

    const out = await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1');

    expect(cloneMock).toHaveBeenCalled();
    expect(out).toContain('/workspace/deps/acme-svc-0');
  });

  it('clones the upstream repos and names the paths in the returned block', async () => {
    stubUpstream(2);
    cloneMock.mockResolvedValue([
      { label: 'acme-svc-0', path: '/workspace/deps/acme-svc-0' },
      { label: 'acme-svc-1', path: '/workspace/deps/acme-svc-1' },
    ]);
    const out = await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1');
    expect(cloneMock).toHaveBeenCalledWith(
      workspace,
      expect.arrayContaining([
        expect.objectContaining({
          authedCloneUrl: 'https://x:tok@github.com/acme/api.git',
          branch: 'main',
          name: 'acme-svc-0',
        }),
      ])
    );
    expect(out).toContain('/workspace/deps/acme-svc-0');
    expect(out).toContain('never edit them');
  });

  it('caps the number of repos handed to the cloner', async () => {
    stubUpstream(MAX_CROSS_REPO_NEIGHBORS + 4);
    await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1');
    expect(cloneMock.mock.calls[0][1]).toHaveLength(MAX_CROSS_REPO_NEIGHBORS);
  });

  it('returns empty when nothing could be cloned', async () => {
    stubUpstream(1);
    cloneMock.mockResolvedValue([]);
    expect(await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1')).toBe('');
  });

  it('swallows a credential failure for one dependency', async () => {
    stubUpstream(2);
    credentialsMock.mockRejectedValueOnce(new Error('no token'));
    cloneMock.mockResolvedValue([{ label: 'acme-svc-1', path: '/workspace/deps/acme-svc-1' }]);
    const out = await checkoutUpstreamRepos(workspace, 'repo-1', 'org-1');
    expect(cloneMock.mock.calls[0][1]).toHaveLength(1);
    expect(out).toContain('/workspace/deps/acme-svc-1');
  });

  it('swallows a clone failure entirely', async () => {
    stubUpstream(1);
    cloneMock.mockRejectedValue(new Error('docker gone'));
    await expect(checkoutUpstreamRepos(workspace, 'repo-1', 'org-1')).resolves.toBe('');
  });
});
