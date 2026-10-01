import { beforeEach, describe, expect, it, vi } from 'vitest';

const credentialPolicy = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  resolveUserCredentialPolicy: () => credentialPolicy(),
}));

const recordRepoPermission = vi.fn();
vi.mock('@auto-swe/shared/lib/repoAccessProjection', () => ({
  recordRepoPermission: (...a: unknown[]) => recordRepoPermission(...a),
}));

const lookupRepoPermission = vi.fn();
const lookupPermissionViaUserCredential = vi.fn();
const verifiedGithubLoginFor = vi.fn();
vi.mock('@auto-swe/shared/lib/repoPermission', () => ({
  lookupPermissionViaUserCredential: (...a: unknown[]) => lookupPermissionViaUserCredential(...a),
  lookupRepoPermission: (...a: unknown[]) => lookupRepoPermission(...a),
  PERMISSION_REPO_SELECT: {},
  verifiedGithubLoginFor: (...a: unknown[]) => verifiedGithubLoginFor(...a),
}));

vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: (_reason: string, _models: string[], fn: () => unknown) => fn(),
}));

const { refreshInvalidatedAccess } = await import('./repoAccessRefresh.js');

const findMany = vi.fn();
const prisma = { connection: { findMany } } as never;

function repo(
  members: { id: string; githubLogin: string | null }[],
  credentials: { userId: string }[] = []
) {
  return {
    credentials,
    githubApiUrl: null,
    id: 'conn-1',
    installation: null,
    organizationName: 'acme',
    repoName: 'payments',
    team: { memberships: members.map((user) => ({ user })) },
  };
}

const REPO_EVENT = { kind: 'repo' as const, org: 'acme', repo: 'payments' };

beforeEach(() => {
  vi.clearAllMocks();
  credentialPolicy.mockResolvedValue({ enabled: true, hosts: ['github.com'] });
  recordRepoPermission.mockResolvedValue({ written: true });
  verifiedGithubLoginFor.mockImplementation(async (_p: unknown, userId: string) =>
    userId === 'user-2' ? 'hubot' : null
  );
  lookupRepoPermission.mockResolvedValue({ ok: true, permission: 'read' });
  lookupPermissionViaUserCredential.mockResolvedValue({ ok: true, permission: 'write' });
});

describe('refreshInvalidatedAccess with saved user credentials', () => {
  it("asks with a holder's own token, including one with no login", async () => {
    findMany.mockResolvedValue([
      repo(
        [
          { githubLogin: null, id: 'user-1' },
          { githubLogin: 'hubot', id: 'user-2' },
        ],
        [{ userId: 'user-1' }]
      ),
    ]);

    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT);

    expect(outcome.refreshed).toBe(2);
    expect(lookupPermissionViaUserCredential).toHaveBeenCalledTimes(1);
    expect(lookupPermissionViaUserCredential.mock.calls[0][2]).toBe('user-1');
    expect(lookupRepoPermission).toHaveBeenCalledTimes(1);
    expect(lookupRepoPermission.mock.calls[0][1]).toBe('hubot');
  });

  it('skips a credential holder without a login while the feature is off', async () => {
    credentialPolicy.mockResolvedValue({ enabled: false, hosts: [] });
    findMany.mockResolvedValue([
      repo([{ githubLogin: null, id: 'user-1' }], [{ userId: 'user-1' }]),
    ]);

    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT);

    expect(outcome).toEqual({ failed: 0, refreshed: 0 });
    expect(lookupPermissionViaUserCredential).not.toHaveBeenCalled();
  });

  it('falls back to the login when the credential is not usable', async () => {
    findMany.mockResolvedValue([
      repo([{ githubLogin: 'hubot', id: 'user-2' }], [{ userId: 'user-2' }]),
    ]);
    lookupPermissionViaUserCredential.mockResolvedValue(null);

    await refreshInvalidatedAccess(prisma, REPO_EVENT);

    expect(lookupRepoPermission.mock.calls[0][1]).toBe('hubot');
  });
});
