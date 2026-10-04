import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';

const resolveUserCredentialPolicy = vi.fn();
const resolveUserCredential = vi.fn();
const repositoryHostsAllowed = vi.fn();
const approvedRepositoryHosts = vi.fn();
vi.mock('./connectionCredential.js', () => ({
  approvedRepositoryHosts: () => approvedRepositoryHosts(),
  repositoryHostsAllowed: (...a: unknown[]) => repositoryHostsAllowed(...a),
  resolveUserCredential: (...a: unknown[]) => resolveUserCredential(...a),
  resolveUserCredentialPolicy: () => resolveUserCredentialPolicy(),
}));

const fetchOwnRepoPermission = vi.fn();
const fetchRepoPermission = vi.fn();
vi.mock('./githubPermission.js', () => ({
  fetchOwnRepoPermission: (...a: unknown[]) => fetchOwnRepoPermission(...a),
  fetchRepoPermission: (...a: unknown[]) => fetchRepoPermission(...a),
}));

// The per-host credential table, with a stand-in for decryption (the row's
// ciphertext is the plaintext), so the real resolver runs end to end.
const hostCredentialFindUnique = vi.fn();
vi.mock('../db.js', () => ({
  prisma: {
    gitHubHostCredential: { findUnique: (...a: unknown[]) => hostCredentialFindUnique(...a) },
  },
}));
vi.mock('./crypto.js', () => ({
  decryptSecret: (e: { ciphertext: Buffer }) => e.ciphertext.toString(),
}));
/** A stored PAT-only host credential row. */
const patRow = (host: string, pat: string) => ({
  appId: null,
  appPrivateKeyAuthTag: null,
  appPrivateKeyCiphertext: null,
  appPrivateKeyKeyVersion: null,
  appPrivateKeyNonce: null,
  host,
  tokenAuthTag: Buffer.from('t'),
  tokenCiphertext: Buffer.from(pat),
  tokenKeyVersion: 1,
  tokenNonce: Buffer.from('n'),
});

const resolveGitHubConfig = vi.fn();
vi.mock('./systemConfig.js', () => ({
  resolveGitHubConfig: () => resolveGitHubConfig(),
}));

const { lookupPermissionViaUserCredential, lookupRepoPermission, verifiedGithubLoginFor } =
  await import('./repoPermission.js');
const { clearInstallationTokenCache } = await import('./githubInstallation.js');

const prisma = {} as PrismaClient;
const REPO = {
  githubApiUrl: 'https://ghe.corp/api/v3',
  githubUrl: 'https://ghe.corp',
  id: 'conn-1',
  installation: null,
  organizationName: 'acme',
  repoName: 'payments',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearInstallationTokenCache();
  repositoryHostsAllowed.mockResolvedValue({ ok: true });
  approvedRepositoryHosts.mockResolvedValue(['github.com', 'api.github.com', 'ghe.corp']);
  hostCredentialFindUnique.mockResolvedValue(null);
  fetchRepoPermission.mockResolvedValue({ ok: true, permission: 'read' });
  resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['ghe.corp'] });
  resolveUserCredential.mockResolvedValue({
    apiUrl: 'https://ghe.corp/api/v3',
    baseUrl: 'https://ghe.corp',
    token: 'ghp_user',
  });
  fetchOwnRepoPermission.mockResolvedValue({ ok: true, permission: 'write' });
});

describe('lookupPermissionViaUserCredential', () => {
  it('asks GitHub with the token, at the host the resolver approved', async () => {
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toEqual({
      ok: true,
      permission: 'write',
    });
    expect(resolveUserCredential).toHaveBeenCalledWith(prisma, {
      connectionId: 'conn-1',
      userId: 'user-1',
    });
    expect(fetchOwnRepoPermission).toHaveBeenCalledWith({
      apiUrl: 'https://ghe.corp/api/v3',
      organizationName: 'acme',
      repoName: 'payments',
      token: 'ghp_user',
    });
  });

  it('returns null — the login path — when the policy cannot be read', async () => {
    // A settings hiccup in this feature must not refuse launches for users who
    // never saved a token; the pre-existing question still gets asked.
    resolveUserCredentialPolicy.mockRejectedValue(new Error('settings store down'));
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it('returns null while the feature is off, or with no usable credential', async () => {
    resolveUserCredentialPolicy.mockResolvedValue({ enabled: false, hosts: [] });
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();

    resolveUserCredentialPolicy.mockResolvedValue({ enabled: true, hosts: ['ghe.corp'] });
    resolveUserCredential.mockResolvedValue(null);
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toBeNull();
    expect(fetchOwnRepoPermission).not.toHaveBeenCalled();
  });

  it('reports an unreadable credential as unanswered rather than throwing', async () => {
    // One bad row must not stop a sweep for everyone; the launch gate fails
    // closed on it, and nothing is written to the projection.
    resolveUserCredential.mockRejectedValue(new Error('No CONFIG_ENCRYPTION_KEY for version 3'));
    await expect(lookupPermissionViaUserCredential(prisma, REPO, 'user-1')).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
  });
});

describe('lookupRepoPermission and the platform credential', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const instance = (over: object = {}) => ({
    apiUrl: 'https://api.github.com',
    appId: '1',
    appInstallationId: '900001',
    appPrivateKey: PEM,
    authMode: 'app',
    baseUrl: 'https://github.com',
    token: 'instance-pat',
    ...over,
  });
  const repo = (over: object = {}) => ({
    githubApiUrl: null,
    githubUrl: null,
    installation: null,
    organizationName: 'acme',
    repoName: 'payments',
    ...over,
  });
  const GHE = { githubApiUrl: 'https://ghe.corp/api/v3', githubUrl: 'https://ghe.corp' };
  const HOST_MISMATCH = { failure: 'host-mismatch', ok: false };
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resolveGitHubConfig.mockResolvedValue(instance());
    fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            token: 'minted',
          }),
          { status: 201 }
        )
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts no App JWT to a foreign host with no installation of its own (App mode)', async () => {
    await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual(HOST_MISMATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it('reports an unapproved host as a standing mismatch, not a transient failure', async () => {
    // "Try again shortly" can never help: an admin has to approve the host.
    repositoryHostsAllowed.mockResolvedValue({ ok: false, url: 'https://ghe.corp/api/v3' });
    await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual(HOST_MISMATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends no instance PAT to a foreign host (PAT mode)', async () => {
    resolveGitHubConfig.mockResolvedValue(instance({ authMode: 'pat' }));
    await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual(HOST_MISMATCH);
    await expect(
      lookupRepoPermission(
        repo({ ...GHE, installation: { host: 'ghe.corp', installationId: '7' } }),
        'octocat'
      )
    ).resolves.toEqual(HOST_MISMATCH);
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  describe("with a platform credential configured for the repository's host", () => {
    it("asks that host's API with that host's PAT, never the instance's", async () => {
      hostCredentialFindUnique.mockResolvedValue(patRow('ghe.corp', 'host-pat'));
      await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual({
        ok: true,
        permission: 'read',
      });
      expect(hostCredentialFindUnique).toHaveBeenCalledWith({ where: { host: 'ghe.corp' } });
      expect(fetchRepoPermission).toHaveBeenCalledWith(
        expect.objectContaining({ apiUrl: 'https://ghe.corp/api/v3', token: 'host-pat' })
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does not use the instance's installation or App for a host's repository", async () => {
      // The host has a PAT only; the instance App (installed at 900001) must not be minted for it.
      hostCredentialFindUnique.mockResolvedValue(patRow('ghe.corp', 'host-pat'));
      await lookupRepoPermission(
        repo({ ...GHE, installation: { host: 'ghe.corp', installationId: '7' } }),
        'octocat'
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fetchRepoPermission).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'host-pat' })
      );
    });

    it('is a host mismatch once the host is no longer approved', async () => {
      hostCredentialFindUnique.mockResolvedValue(patRow('ghe.corp', 'host-pat'));
      approvedRepositoryHosts.mockResolvedValue(['github.com']);
      await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual(HOST_MISMATCH);
      expect(fetchRepoPermission).not.toHaveBeenCalled();
    });

    it("is still a host mismatch for a half override, whatever the host's credentials", async () => {
      hostCredentialFindUnique.mockResolvedValue(patRow('ghe.corp', 'host-pat'));
      await expect(
        lookupRepoPermission(repo({ githubUrl: GHE.githubUrl }), 'octocat')
      ).resolves.toEqual(HOST_MISMATCH);
      expect(fetchRepoPermission).not.toHaveBeenCalled();
    });
  });

  it('answers "unavailable", not a denial, when the host credentials cannot be loaded', async () => {
    hostCredentialFindUnique.mockRejectedValue(new Error('cannot decrypt'));
    await expect(lookupRepoPermission(repo(GHE), 'octocat')).resolves.toEqual({
      failure: 'unavailable',
      ok: false,
    });
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it('refuses an installation recorded for another host, at mint time', async () => {
    // On the instance's host with an installation of ghe.corp's, and the reverse.
    await expect(
      lookupRepoPermission(repo({ installation: { host: 'ghe.corp', installationId: '7' } }), 'o')
    ).resolves.toEqual(HOST_MISMATCH);
    hostCredentialFindUnique.mockResolvedValue(patRow('ghe.corp', 'host-pat'));
    await expect(
      lookupRepoPermission(repo({ ...GHE, installation: { host: '', installationId: '7' } }), 'o')
    ).resolves.toEqual(HOST_MISMATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it('refuses a half override, whichever side, even with an installation', async () => {
    for (const half of [{ githubApiUrl: GHE.githubApiUrl }, { githubUrl: GHE.githubUrl }]) {
      await expect(
        lookupRepoPermission(
          repo({ ...half, installation: { host: '', installationId: '7' } }),
          'octocat'
        )
      ).resolves.toEqual(HOST_MISMATCH);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it('posts no App JWT, PAT or token to a foreign host even for an installed repository (App mode)', async () => {
    await expect(
      lookupRepoPermission(
        repo({ ...GHE, installation: { host: 'ghe.corp', installationId: '7' } }),
        'octocat'
      )
    ).resolves.toEqual(HOST_MISMATCH);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it("asks the instance host with a repository's own installation's token", async () => {
    await lookupRepoPermission(
      repo({ installation: { host: '', installationId: '7' } }),
      'octocat'
    );
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.github.com/app/installations/7/access_tokens'
    );
    expect(fetchRepoPermission).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://api.github.com', token: 'minted' })
    );
  });

  it('asks the instance host with the instance credential', async () => {
    resolveGitHubConfig.mockResolvedValue(instance({ authMode: 'pat' }));
    await lookupRepoPermission(repo(), 'octocat');
    expect(fetchRepoPermission).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://api.github.com', token: 'instance-pat' })
    );
  });
});

describe('verifiedGithubLoginFor and the platform credential', () => {
  const prismaStub = {
    account: { findMany: vi.fn(async () => [{ accountId: '4242' }]) },
    user: { findUnique: vi.fn(async () => ({ githubLogin: 'octocat' })), update: vi.fn() },
  } as never;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 4242 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the instance's credential to github.com only when the instance is on github.com", async () => {
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://api.github.com',
      authMode: 'pat',
      baseUrl: 'https://github.com',
      token: 'dotcom-pat',
    });
    await expect(verifiedGithubLoginFor(prismaStub, 'u1')).resolves.toBe('octocat');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.github.com/users/octocat');
    expect(JSON.stringify(init.headers)).toContain('dotcom-pat');
  });

  it("verifies a github.com login with github.com's own host credential on a GitHub Enterprise instance", async () => {
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://ghe.corp/api/v3',
      authMode: 'pat',
      baseUrl: 'https://ghe.corp',
      token: 'ghe-pat',
    });
    approvedRepositoryHosts.mockResolvedValue(['ghe.corp', 'github.com']);
    hostCredentialFindUnique.mockResolvedValue(patRow('github.com', 'dotcom-host-pat'));
    await expect(verifiedGithubLoginFor(prismaStub, 'u1')).resolves.toBe('octocat');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.github.com/users/octocat');
    expect(JSON.stringify(init.headers)).toContain('dotcom-host-pat');
    expect(JSON.stringify(init.headers)).not.toContain('ghe-pat');
  });

  it("verifies a GitHub Enterprise sign-in account at the instance's own host with its credential", async () => {
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://ghe.corp/api/v3',
      authMode: 'pat',
      baseUrl: 'https://ghe.corp',
      token: 'ghe-pat',
    });
    const stub = {
      account: { findMany: vi.fn(async () => [{ accountId: 'ghe.corp:4242' }]) },
      user: { findUnique: vi.fn(async () => ({ githubLogin: 'octocat' })), update: vi.fn() },
    } as never;
    await expect(verifiedGithubLoginFor(stub, 'u1')).resolves.toBe('octocat');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ghe.corp/api/v3/users/octocat');
    expect(JSON.stringify(init.headers)).toContain('ghe-pat');
  });

  it('calls github.com unauthenticated on a GitHub Enterprise instance, and still answers', async () => {
    resolveGitHubConfig.mockResolvedValue({
      apiUrl: 'https://ghe.corp/api/v3',
      authMode: 'pat',
      baseUrl: 'https://ghe.corp',
      token: 'ghe-pat',
    });
    await expect(verifiedGithubLoginFor(prismaStub, 'u1')).resolves.toBe('octocat');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://api.github.com/users/octocat');
    expect(JSON.stringify(init.headers ?? {})).not.toContain('ghe-pat');
    expect(JSON.stringify(init.headers ?? {})).not.toContain('Authorization');
  });
});
