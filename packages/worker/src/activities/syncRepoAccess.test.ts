import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const upsert = vi.fn();
const repoPermission = vi.fn();

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findMany: (...a: unknown[]) => findMany(...a) },
    repoAccess: { upsert: (...a: unknown[]) => upsert(...a) },
  },
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({ repoPermission: (...a: unknown[]) => repoPermission(...a) }),
  toRepoRef: (r: { organizationName: string; repoName: string }) => ({
    organizationName: r.organizationName,
    repoName: r.repoName,
  }),
}));

const { syncRepoAccess } = await import('./syncRepoAccess.js');

function repo(members: { id: string; githubLogin: string | null }[], over = {}) {
  return {
    githubApiUrl: null,
    githubUrl: null,
    id: 'conn-1',
    installation: null,
    organizationName: 'acme',
    repoName: 'payments',
    team: { memberships: members.map((user) => ({ user })) },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
});

describe('syncRepoAccess', () => {
  it('records what GitHub says for each reachable pair', async () => {
    findMany.mockResolvedValue([
      repo([
        { githubLogin: 'octocat', id: 'user-1' },
        { githubLogin: 'hubot', id: 'user-2' },
      ]),
    ]);
    repoPermission
      .mockResolvedValueOnce({ ok: true, permission: 'write' })
      .mockResolvedValueOnce({ ok: true, permission: 'read' });

    await expect(syncRepoAccess({})).resolves.toMatchObject({ failed: 0, refreshed: 2 });
    expect(upsert).toHaveBeenNthCalledWith(1, {
      create: { connectionId: 'conn-1', permission: 'WRITE', userId: 'user-1' },
      update: { checkedAt: expect.any(Date), permission: 'WRITE' },
      where: { userId_connectionId: { connectionId: 'conn-1', userId: 'user-1' } },
    });
    expect(upsert.mock.calls[1][0].create.permission).toBe('READ');
  });

  it('writes GitHub’s own "none" as a recorded denial', async () => {
    // A real `none` is a fact and must be stored, or the gate could not tell a
    // user with no access from one nobody has asked about yet.
    findMany.mockResolvedValue([repo([{ githubLogin: 'octocat', id: 'user-1' }])]);
    repoPermission.mockResolvedValue({ ok: true, permission: 'none' });

    await syncRepoAccess({});
    expect(upsert.mock.calls[0][0].create.permission).toBe('NONE');
  });

  it('never overwrites a known answer when the lookup fails', async () => {
    // The central invariant. An outage, a rate limit, or a wrong installation
    // must leave the previous row untouched so it ages out through the
    // staleness window, rather than being written down as a denial GitHub
    // never made — which would be indistinguishable from a real one.
    findMany.mockResolvedValue([repo([{ githubLogin: 'octocat', id: 'user-1' }])]);
    for (const failure of [
      'unavailable',
      'rate-limited',
      'credential-rejected',
      'repo-not-found',
    ]) {
      upsert.mockClear();
      repoPermission.mockResolvedValue({ failure, ok: false });
      await expect(syncRepoAccess({})).resolves.toMatchObject({ failed: 1, refreshed: 0 });
      expect(upsert).not.toHaveBeenCalled();
    }
  });

  it('counts a user with no GitHub login instead of asking about nobody', async () => {
    findMany.mockResolvedValue([repo([{ githubLogin: null, id: 'user-1' }])]);
    await expect(syncRepoAccess({})).resolves.toMatchObject({ refreshed: 0, unresolvedUsers: 1 });
    expect(repoPermission).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('skips a connection with no git identity rather than asking GitHub about null', async () => {
    findMany.mockResolvedValue([
      repo([{ githubLogin: 'octocat', id: 'user-1' }], { organizationName: null, repoName: null }),
    ]);
    await expect(syncRepoAccess({})).resolves.toMatchObject({ refreshed: 0, skippedRepos: 1 });
    expect(repoPermission).not.toHaveBeenCalled();
  });

  it('keeps going after one pair fails', async () => {
    // One bad repository must not stop the sweep for every other.
    findMany.mockResolvedValue([
      repo([
        { githubLogin: 'octocat', id: 'user-1' },
        { githubLogin: 'hubot', id: 'user-2' },
      ]),
    ]);
    repoPermission
      .mockResolvedValueOnce({ failure: 'rate-limited', ok: false })
      .mockResolvedValueOnce({ ok: true, permission: 'admin' });

    await expect(syncRepoAccess({})).resolves.toMatchObject({ failed: 1, refreshed: 1 });
    expect(upsert.mock.calls[0][0].create.userId).toBe('user-2');
  });

  it('narrows to one user when asked, without touching the others', async () => {
    // The webhook path refreshes a single person; it must not silently re-sweep
    // everyone on the team and multiply the API cost of one membership change.
    findMany.mockResolvedValue([
      repo([
        { githubLogin: 'octocat', id: 'user-1' },
        { githubLogin: 'hubot', id: 'user-2' },
      ]),
    ]);
    repoPermission.mockResolvedValue({ ok: true, permission: 'write' });

    await syncRepoAccess({ userId: 'user-2' });
    expect(repoPermission).toHaveBeenCalledTimes(1);
    expect(repoPermission.mock.calls[0][1]).toBe('hubot');
  });
});
