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

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

const findMany = vi.fn();
const secretHosts = vi.fn();
const prisma = {
  connection: { findMany },
  gitHubHostWebhookSecret: { findMany: secretHosts },
} as never;

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
    shares: [],
    team: { memberships: members.map((user) => ({ user })) },
  };
}

const REPO_EVENT = { kind: 'repo' as const, org: 'acme', repo: 'payments' };

beforeEach(() => {
  vi.clearAllMocks();
  secretHosts.mockResolvedValue([]);
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

    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT, null);

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

    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT, null);

    expect(outcome).toEqual({ failed: 0, refreshed: 0 });
    expect(lookupPermissionViaUserCredential).not.toHaveBeenCalled();
  });

  it('falls back to the login when the credential is not usable', async () => {
    findMany.mockResolvedValue([
      repo([{ githubLogin: 'hubot', id: 'user-2' }], [{ userId: 'user-2' }]),
    ]);
    lookupPermissionViaUserCredential.mockResolvedValue(null);

    await refreshInvalidatedAccess(prisma, REPO_EVENT, null);

    expect(lookupRepoPermission.mock.calls[0][1]).toBe('hubot');
  });
});

describe('refreshInvalidatedAccess binds the delivery to the host its secret proved', () => {
  const connections = [
    { githubUrl: null, id: 'conn-1', repoName: 'payments' },
    { githubUrl: 'https://ghe.corp', id: 'conn-ghe', repoName: 'ghe-only' },
  ];

  /** A database over `connections` that honours the `id` predicate of the refresh query. */
  function database() {
    type IdWhere = { in?: string[]; notIn?: string[] };
    type Where = { AND?: Array<{ id?: IdWhere }>; id?: IdWhere; repoName?: { equals: string } };
    findMany.mockImplementation(async (args: { select?: object; where: Where }) => {
      if ('githubUrl' in (args.select ?? {})) {
        return connections;
      }
      const idWhere = args.where.id ?? args.where.AND?.find((w) => w.id)?.id;
      return connections
        .filter((c) => !args.where.repoName || args.where.repoName.equals === c.repoName)
        .filter((c) => (idWhere?.in ? idWhere.in.includes(c.id) : !idWhere?.notIn?.includes(c.id)))
        .map((c) => ({ ...repo([{ githubLogin: 'hubot', id: 'user-2' }]), id: c.id }));
    });
  }

  it('does not refresh a github.com repository for a delivery signed by another host', async () => {
    database();
    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT, 'ghe.corp');
    expect(outcome.skipped).toMatch(/no configured repository/);
    expect(lookupRepoPermission).not.toHaveBeenCalled();
  });

  it('refreshes a repository on the host that signed the delivery', async () => {
    database();
    const outcome = await refreshInvalidatedAccess(
      prisma,
      { ...REPO_EVENT, htmlUrl: 'https://ghe.corp/acme/ghe-only', repo: 'ghe-only' },
      'ghe.corp'
    );
    expect(outcome.refreshed).toBe(1);
  });

  it('does not let the instance secret refresh a repository on a host with its own secret', async () => {
    database();
    secretHosts.mockResolvedValue([{ host: 'ghe.corp' }]);
    const outcome = await refreshInvalidatedAccess(prisma, REPO_EVENT, null);
    // Only the instance-host repository is reachable, and it is refreshed.
    expect(outcome.refreshed).toBe(1);
    const where = findMany.mock.calls.at(-1)?.[0].where;
    expect(where.id).toEqual({ notIn: ['conn-ghe'] });
  });

  it('confines a user-wide event to the verified host as well', async () => {
    database();
    await refreshInvalidatedAccess(prisma, { kind: 'user', login: 'hubot' }, 'ghe.corp');
    const where = findMany.mock.calls.at(-1)?.[0].where;
    expect(where.AND[1]).toEqual({ id: { in: ['conn-ghe'] } });
  });
});
