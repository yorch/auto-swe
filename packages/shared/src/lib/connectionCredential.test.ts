import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../index.js';

const resolveSettings = vi.fn();
const resolveSetting = vi.fn();
vi.mock('../config/index.js', () => ({
  resolveSetting: (...a: unknown[]) => resolveSetting(...a),
  resolveSettings: (...a: unknown[]) => resolveSettings(...a),
}));

vi.mock('./systemConfig.js', () => ({
  resolveGitHubConfig: async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  }),
}));

const {
  CredentialUnreadableError,
  credentialHostAllowed,
  encryptCredentialToken,
  repositoryHostsAllowed,
  resolveUserCredential,
} = await import('./connectionCredential.js');
const { _resetKeyCacheForTests } = await import('./crypto.js');

function policy(enabled: boolean, hosts: string[] = ['github.com']) {
  resolveSettings.mockResolvedValue({
    'github.userCredentialHosts': hosts,
    'github.userCredentialsEnabled': enabled,
  });
}

describe('credentialHostAllowed', () => {
  const hosts = ['github.com', 'ghe.corp', 'ghe.other:8443'];

  it('admits listed hosts over https, and api.github.com through github.com', () => {
    expect(credentialHostAllowed('https://github.com', hosts)).toBe(true);
    expect(credentialHostAllowed('https://api.github.com', hosts)).toBe(true);
    expect(credentialHostAllowed('https://ghe.corp/api/v3', hosts)).toBe(true);
    expect(credentialHostAllowed('https://ghe.other:8443/api/v3', hosts)).toBe(true);
  });

  it('refuses anything that is not an exact listed host', () => {
    // No suffix matching: each of these is a host somebody else can own.
    expect(credentialHostAllowed('https://evil-github.com', hosts)).toBe(false);
    expect(credentialHostAllowed('https://github.com.evil.io', hosts)).toBe(false);
    expect(credentialHostAllowed('https://sub.ghe.corp', hosts)).toBe(false);
    // A port is part of the host: listing the bare name does not admit it.
    expect(credentialHostAllowed('https://ghe.corp:8443', hosts)).toBe(false);
    expect(credentialHostAllowed('https://ghe.other', hosts)).toBe(false);
    // api.github.com is implied only by github.com itself.
    expect(credentialHostAllowed('https://api.github.com', ['ghe.corp'])).toBe(false);
  });

  it('refuses plain http, embedded userinfo, and unparseable input', () => {
    expect(credentialHostAllowed('http://github.com', hosts)).toBe(false);
    expect(credentialHostAllowed('https://user:pw@github.com', hosts)).toBe(false);
    expect(credentialHostAllowed('https://x@evil.io', hosts)).toBe(false);
    expect(credentialHostAllowed('not a url', hosts)).toBe(false);
    expect(credentialHostAllowed('https://github.com', [])).toBe(false);
  });

  it('refuses a base URL carrying a query or fragment', () => {
    // These get concatenated into clone and API URLs, where `?@x` or `#@x`
    // could make git parse a different host than the one checked here.
    expect(credentialHostAllowed('https://github.com?@evil.io', hosts)).toBe(false);
    expect(credentialHostAllowed('https://github.com#@evil.io', hosts)).toBe(false);
    expect(credentialHostAllowed('https://github.com/?', hosts)).toBe(false);
  });

  it('refuses any URL not already in canonical form', () => {
    // WHATWG reads this host as github.com; git and curl need not agree.
    expect(credentialHostAllowed('https://github.com\\@evil.example', hosts)).toBe(false);
    expect(credentialHostAllowed('https://GHE.CORP/api/v3', hosts)).toBe(false);
    expect(credentialHostAllowed('https://ghe.corp:443/api/v3', hosts)).toBe(false);
    // A trailing slash, or its absence, is not a difference.
    expect(credentialHostAllowed('https://ghe.corp/', hosts)).toBe(true);
    expect(credentialHostAllowed('https://ghe.corp/api/v3/', hosts)).toBe(true);
  });
});

describe('resolveUserCredential', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;
  const ARGS = { connectionId: 'conn-1', userId: 'user-1' };

  let findUnique: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  function row(over: Record<string, unknown> = {}) {
    return {
      ...encryptCredentialToken('ghp_usertoken1234'),
      apiOrigin: 'https://api.github.com',
      connection: {
        githubApiUrl: null,
        githubUrl: null,
        shares: [],
        team: { memberships: [{ userId: 'user-1' }] },
      },
      user: { isActive: true, role: 'ENGINEER' },
      webOrigin: 'https://github.com',
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    _resetKeyCacheForTests();
    findUnique = vi.fn().mockResolvedValue(row());
    prisma = { connectionCredential: { findUnique } } as unknown as PrismaClient;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    }
    _resetKeyCacheForTests();
  });

  it("returns the owner's own decrypted token and where it may go", async () => {
    policy(true);
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toEqual({
      apiUrl: 'https://api.github.com',
      baseUrl: 'https://github.com',
      token: 'ghp_usertoken1234',
    });
    // Keyed on the pair — never on the repository alone, which is what keeps
    // one user's token out of another user's run.
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connectionId_userId: { connectionId: 'conn-1', userId: 'user-1' } },
      })
    );
  });

  it('reads nothing while the feature is off', async () => {
    policy(false);
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the user saved no token', async () => {
    policy(true);
    findUnique.mockResolvedValue(null);
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();
  });

  it('refuses a deactivated owner, and one no longer on the team', async () => {
    policy(true);
    findUnique.mockResolvedValue(row({ user: { isActive: false, role: 'ENGINEER' } }));
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();

    const leftTeam = row();
    leftTeam.connection.team.memberships = [];
    findUnique.mockResolvedValue(leftTeam);
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();

    // A platform admin passes membership, as on every other repository check.
    leftTeam.user = { isActive: true, role: 'ADMIN' };
    findUnique.mockResolvedValue(leftTeam);
    await expect(resolveUserCredential(prisma, ARGS)).resolves.not.toBeNull();
  });

  it('refuses when a repository host is not on the allowlist', async () => {
    // Saved against GHE, then the admin removed GHE from the list.
    policy(true, ['github.com']);
    findUnique.mockResolvedValue(
      row({
        apiOrigin: 'https://ghe.corp',
        connection: {
          githubApiUrl: 'https://ghe.corp/api/v3',
          githubUrl: 'https://ghe.corp',
          shares: [],
          team: { memberships: [{ userId: 'user-1' }] },
        },
        webOrigin: 'https://ghe.corp',
      })
    );
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();
  });

  it('refuses when the repository was repointed after the token was verified', async () => {
    // Both hosts are allowed, but the token was confirmed against GHE and the
    // repository now points at github.com: it must not follow the repository.
    policy(true, ['github.com', 'ghe.corp']);
    findUnique.mockResolvedValue(
      row({ apiOrigin: 'https://ghe.corp', webOrigin: 'https://ghe.corp' })
    );
    await expect(resolveUserCredential(prisma, ARGS)).resolves.toBeNull();
  });

  it('reports an undecryptable token as its own error, not a database one', async () => {
    // Written under a key version this process no longer holds: retrying will
    // not help, so the worker must be able to tell it apart and fail fast.
    policy(true);
    findUnique.mockResolvedValue(row({ tokenKeyVersion: 99 }));
    await expect(resolveUserCredential(prisma, ARGS)).rejects.toBeInstanceOf(
      CredentialUnreadableError
    );
  });

  it('throws rather than degrading to null when the row cannot be read', async () => {
    // Null means "use the platform credential"; a database failure must not
    // silently switch the identity a run acts as.
    policy(true);
    findUnique.mockRejectedValue(new Error('connection reset'));
    await expect(resolveUserCredential(prisma, ARGS)).rejects.toThrow('connection reset');
  });
});

describe('repositoryHostsAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSetting.mockResolvedValue(['ghe.corp']);
  });

  it('allows a repository with no overrides without reading anything', async () => {
    await expect(repositoryHostsAllowed({ githubApiUrl: null, githubUrl: null })).resolves.toEqual({
      ok: true,
    });
    expect(resolveSetting).not.toHaveBeenCalled();
  });

  it("allows the instance's own hosts and the admin-listed ones", async () => {
    await expect(
      repositoryHostsAllowed({ githubApiUrl: 'https://api.github.com', githubUrl: null })
    ).resolves.toEqual({ ok: true });
    await expect(
      repositoryHostsAllowed({
        githubApiUrl: 'https://ghe.corp/api/v3',
        githubUrl: 'https://ghe.corp',
      })
    ).resolves.toEqual({ ok: true });
  });

  it('refuses, and names, an override on a host nobody approved', async () => {
    // A team lead pointing a repository at a host they control would otherwise
    // receive the platform token on the next run.
    await expect(
      repositoryHostsAllowed({
        githubApiUrl: 'https://ghe.corp/api/v3',
        githubUrl: 'https://collector.example',
      })
    ).resolves.toEqual({ ok: false, url: 'https://collector.example' });
  });

  it('refuses a non-canonical override even on an allowed host', async () => {
    await expect(
      repositoryHostsAllowed({ githubApiUrl: null, githubUrl: 'https://github.com\\@evil.example' })
    ).resolves.toMatchObject({ ok: false });
  });
});
