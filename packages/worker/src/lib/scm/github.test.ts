import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
  })),
}));

vi.mock('../githubAuth.js', () => ({
  GitHubTokenMissingError: class GitHubTokenMissingError extends Error {},
  requireGitHubToken: vi.fn(async () => 'ghp_tok'),
  resolveGitHubToken: vi.fn(async () => 'ghp_tok'),
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  CredentialUnreadableError: class CredentialUnreadableError extends Error {},
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
  resolveUserCredential: vi.fn(async () => null),
  resolveUserCredentialPolicy: vi.fn(async () => ({ enabled: true, hosts: ['github.com'] })),
}));

vi.mock('../runLauncher.js', () => ({
  currentRunLauncherId: vi.fn(async () => null),
}));

import {
  CredentialUnreadableError,
  repositoryHostsAllowed,
  resolveUserCredential,
  resolveUserCredentialPolicy,
} from '@auto-swe/shared/lib/connectionCredential';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { requireGitHubToken, resolveGitHubToken } from '../githubAuth.js';
import { currentRunLauncherId } from '../runLauncher.js';
import { GitHubScmProvider, resolveCiLogsTarget } from './github.js';

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () => 'log body',
}));

beforeEach(() => {
  fetchMock.mockClear();
  vi.mocked(resolveGitHubToken).mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastFetch(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as unknown as [URL, RequestInit];
  return { init: call[1], url: call[0].toString() };
}

describe('resolveCiLogsTarget', () => {
  const trusted = ['https://github.com', 'https://api.github.com'];

  it('trusts https URLs on the configured GitHub origins', () => {
    expect(resolveCiLogsTarget('https://github.com/acme/api/runs/1', trusted)).toMatchObject({
      ok: true,
      trusted: true,
    });
    expect(resolveCiLogsTarget('https://api.github.com/repos/a/b/logs', trusted)).toMatchObject({
      ok: true,
      trusted: true,
    });
  });

  it('does not trust a foreign origin, a sibling subdomain, or plain http', () => {
    for (const url of [
      'https://evil.example/logs',
      'https://github.com.evil.example/logs',
      'https://gist.github.com/x',
      'http://github.com/acme/api/runs/1',
    ]) {
      expect(resolveCiLogsTarget(url, trusted)).toMatchObject({ ok: true, trusted: false });
    }
  });

  it('refuses internal hosts and non-http schemes outright', () => {
    for (const url of [
      'http://127.0.0.1:9/logs',
      'http://169.254.169.254/latest/meta-data',
      'https://ci.internal/logs',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(resolveCiLogsTarget(url, trusted)).toMatchObject({ ok: false });
    }
  });
});

describe('GitHubScmProvider.fetchCiLogs', () => {
  const provider = new GitHubScmProvider();

  it('sends the bearer token, with a timeout, to the configured GitHub origin', async () => {
    const out = await provider.fetchCiLogs('https://github.com/acme/api/actions/runs/1');
    expect(out).toBe('log body');
    const { init, url } = lastFetch();
    expect(url).toBe('https://github.com/acme/api/actions/runs/1');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_tok' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never sends the token to a foreign origin', async () => {
    await provider.fetchCiLogs('https://ci.example.com/build/42/log');
    const { init } = lastFetch();
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(vi.mocked(resolveGitHubToken)).not.toHaveBeenCalled();
  });

  it('never sends the token over plain http, even to the GitHub host', async () => {
    await provider.fetchCiLogs('http://github.com/acme/api/actions/runs/1');
    expect(lastFetch().init.headers).not.toHaveProperty('Authorization');
  });

  it('refuses to fetch an internal or non-http URL at all', async () => {
    const out = await provider.fetchCiLogs('http://169.254.169.254/latest/meta-data');
    expect(out).toContain('refusing to fetch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trusts a GitHub Enterprise origin taken from the configured base/API URLs', async () => {
    const ghe = { apiUrl: 'https://ghe.corp.example/api/v3', baseUrl: 'https://ghe.corp.example' };
    vi.mocked(resolveGitHubConfig)
      .mockResolvedValueOnce(ghe as never)
      .mockResolvedValueOnce(ghe as never);
    await provider.fetchCiLogs('https://ghe.corp.example/acme/api/runs/7');
    expect(lastFetch().init.headers).toMatchObject({ Authorization: 'Bearer ghp_tok' });
    // github.com is no longer a trusted origin for that deployment's token.
    await provider.fetchCiLogs('https://github.com/acme/api/runs/7');
    expect(lastFetch().init.headers).not.toHaveProperty('Authorization');
  });

  it('reports a non-2xx response instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'nope' });
    const out = await provider.fetchCiLogs('https://github.com/acme/api/runs/1');
    expect(out).toContain('HTTP 404');
  });
});

describe("GitHubScmProvider and the run launcher's own credential", () => {
  const provider = new GitHubScmProvider();
  const REPO = { connectionId: 'conn-1', organizationName: 'acme', repoName: 'api' };
  const USABLE = {
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    token: 'ghp_user',
  };

  beforeEach(() => {
    vi.mocked(currentRunLauncherId).mockReset().mockResolvedValue(null);
    vi.mocked(resolveUserCredential).mockReset().mockResolvedValue(null);
    vi.mocked(resolveUserCredentialPolicy)
      .mockReset()
      .mockResolvedValue({ enabled: true, hosts: ['github.com'] });
    vi.mocked(requireGitHubToken).mockClear();
  });

  it("clones with the launcher's own token", async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockResolvedValue(USABLE);
    const creds = await provider.cloneCredentials(REPO);
    expect(creds.token).toBe('ghp_user');
    expect(creds.authedCloneUrl).toBe('https://x-access-token:ghp_user@github.com/acme/api.git');
    expect(resolveUserCredential).toHaveBeenCalledWith(
      {},
      { connectionId: 'conn-1', userId: 'user-1' }
    );
    expect(requireGitHubToken).not.toHaveBeenCalled();
  });

  it('asks nothing about the launcher while the feature is off', async () => {
    // A deployment that never enabled it pays no extra database round trip.
    vi.mocked(resolveUserCredentialPolicy).mockResolvedValue({ enabled: false, hosts: [] });
    const creds = await provider.cloneCredentials(REPO);
    expect(creds.token).toBe('ghp_tok');
    expect(currentRunLauncherId).not.toHaveBeenCalled();
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it('uses the platform credential when the run has no launcher', async () => {
    // A webhook- or cron-started run acts for nobody, so nobody's token is read.
    const creds = await provider.cloneCredentials(REPO);
    expect(creds.token).toBe('ghp_tok');
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it('uses the platform credential when the launcher has no usable token', async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    const creds = await provider.cloneCredentials(REPO);
    expect(creds.token).toBe('ghp_tok');
    expect(requireGitHubToken).toHaveBeenCalled();
  });

  it('refuses the token when the ref carries different hosts than the resolver checked', async () => {
    // A ref loaded before the repository was repointed must not carry the
    // token to the old host.
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockResolvedValue(USABLE);
    // Nor does it fall back to the platform's credential: that is valid only on
    // the instance's host, and the repository is not on it.
    await expect(
      provider.cloneCredentials({
        ...REPO,
        apiUrl: 'https://ghe.corp/api/v3',
        baseUrl: 'https://ghe.corp',
      })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'REPO_CREDENTIAL_HOST_MISMATCH' });
    expect(requireGitHubToken).not.toHaveBeenCalled();
  });

  it('fails fast, without retrying, on a saved token that cannot be decrypted', async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockRejectedValue(new CredentialUnreadableError('bad key'));
    await expect(provider.cloneCredentials(REPO)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'CREDENTIAL_UNREADABLE',
    });
    // And never falls back to acting as the platform instead.
    expect(requireGitHubToken).not.toHaveBeenCalled();
  });

  it('keeps a database failure retryable', async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockRejectedValue(new Error('connection reset'));
    await expect(provider.cloneCredentials(REPO)).rejects.toThrow('connection reset');
  });

  it('sends no credential at all to a repository on an unapproved host', async () => {
    vi.mocked(repositoryHostsAllowed).mockResolvedValueOnce({
      ok: false,
      url: 'https://collector.example',
    });
    await expect(
      provider.cloneCredentials({ ...REPO, baseUrl: 'https://collector.example' })
    ).rejects.toMatchObject({ nonRetryable: true, type: 'REPO_HOST_NOT_ALLOWED' });
    expect(requireGitHubToken).not.toHaveBeenCalled();
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it('mints no platform token to fetch CI logs for a repository on an unapproved host', async () => {
    // fetchCiLogs reaches the token-minting call without going through the clone
    // or Octokit paths, so it applies the allowlist itself.
    vi.mocked(repositoryHostsAllowed).mockResolvedValueOnce({
      ok: false,
      url: 'https://collector.example/api/v3',
    });
    const out = await provider.fetchCiLogs('https://github.com/acme/api/actions/runs/1', {
      ...REPO,
      apiUrl: 'https://collector.example/api/v3',
      baseUrl: 'https://collector.example',
    });
    expect(out).toContain('not on an allowed GitHub host');
    expect(resolveGitHubToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never looks for a user token on a ref built without a connection', async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    await provider.cloneCredentials({ organizationName: 'acme', repoName: 'api' });
    expect(currentRunLauncherId).not.toHaveBeenCalled();
    expect(resolveUserCredential).not.toHaveBeenCalled();
  });

  it("sends the launcher's token only to the repository's own hosts for CI logs", async () => {
    const gheRepo = {
      ...REPO,
      apiUrl: 'https://ghe.corp/api/v3',
      baseUrl: 'https://ghe.corp',
    };
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockResolvedValue({
      apiUrl: 'https://ghe.corp/api/v3',
      baseUrl: 'https://ghe.corp',
      token: 'ghp_user',
    });

    await provider.fetchCiLogs('https://ghe.corp/acme/api/runs/7', gheRepo);
    expect(lastFetch().init.headers).toMatchObject({ Authorization: 'Bearer ghp_user' });

    // github.com is the instance's origin, not this repository's: the user's
    // GHE token must not go there, and neither does the platform's — the
    // repository is on another host with no installation of its own.
    await provider.fetchCiLogs('https://github.com/acme/api/runs/7', gheRepo);
    expect(lastFetch().init.headers).not.toHaveProperty('Authorization');
    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });
});

describe('the platform credential and the repository host', () => {
  const provider = new GitHubScmProvider();
  const GHE = {
    apiUrl: 'https://ghe.corp/api/v3',
    baseUrl: 'https://ghe.corp',
    organizationName: 'acme',
    repoName: 'api',
  };
  const APP = { appId: '1', appPrivateKey: 'key', authMode: 'app' as const };
  const instance = (extra: object = {}) => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    ...extra,
  });

  beforeEach(() => {
    vi.mocked(requireGitHubToken).mockClear();
    vi.mocked(resolveUserCredential).mockReset().mockResolvedValue(null);
    vi.mocked(currentRunLauncherId).mockReset().mockResolvedValue(null);
    vi.mocked(resolveUserCredentialPolicy)
      .mockReset()
      .mockResolvedValue({ enabled: true, hosts: ['github.com'] });
  });

  it.each([
    ['clone', (r: object) => provider.cloneCredentials(r as never)],
    ['API', (r: object) => provider.fetchFileContent(r as never, 'package.json')],
  ])(
    'refuses the %s credential for a non-instance host with no installation of its own',
    async (_n, call) => {
      await expect(call(GHE)).rejects.toMatchObject({
        message: expect.stringContaining('ghe.corp, which needs its own GitHub App installation'),
        nonRetryable: true,
        type: 'REPO_CREDENTIAL_HOST_MISMATCH',
      });
      expect(requireGitHubToken).not.toHaveBeenCalled();
    }
  );

  it('refuses the instance PAT for a non-instance host even with an installation id (not App mode)', async () => {
    vi.mocked(resolveGitHubConfig).mockResolvedValueOnce(
      instance({ authMode: 'pat', token: 'pat' }) as never
    );
    await expect(
      provider.cloneCredentials({ ...GHE, installationId: '777' } as never)
    ).rejects.toMatchObject({ type: 'REPO_CREDENTIAL_HOST_MISMATCH' });
  });

  it("allows a non-instance host's own installation in App mode", async () => {
    vi.mocked(resolveGitHubConfig).mockResolvedValueOnce(instance(APP) as never);
    const creds = await provider.cloneCredentials({ ...GHE, installationId: '777' } as never);
    expect(creds.token).toBe('ghp_tok');
    expect(requireGitHubToken).toHaveBeenCalled();
  });

  it("still allows a user's own token on a non-instance host", async () => {
    vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
    vi.mocked(resolveUserCredential).mockResolvedValueOnce({
      apiUrl: GHE.apiUrl,
      baseUrl: GHE.baseUrl,
      token: 'ghp_user',
    });
    const creds = await provider.cloneCredentials({ ...GHE, connectionId: 'conn-1' } as never);
    expect(creds.token).toBe('ghp_user');
  });

  it('still uses the platform credential for the instance host', async () => {
    const creds = await provider.cloneCredentials({
      apiUrl: 'https://api.github.com/',
      baseUrl: 'https://GitHub.com',
      organizationName: 'acme',
      repoName: 'api',
    });
    expect(creds.token).toBe('ghp_tok');
  });

  it('fails a repository with its own web host and no API URL, rather than ask the instance', async () => {
    await expect(
      provider.fetchFileContent(
        { baseUrl: 'https://mirror.corp', organizationName: 'acme', repoName: 'api' },
        'package.json'
      )
    ).rejects.toMatchObject({ nonRetryable: true, type: 'REPO_HOST_MISCONFIGURED' });
    expect(requireGitHubToken).not.toHaveBeenCalled();
  });

  it('answers a permission lookup for such a repository as "could not ask"', async () => {
    await expect(provider.repoPermission(GHE as never, 'octocat')).resolves.toEqual({
      failure: 'credential-rejected',
      ok: false,
    });
    await expect(
      provider.repoPermission(
        { baseUrl: 'https://mirror.corp', organizationName: 'acme', repoName: 'api' },
        'octocat'
      )
    ).resolves.toEqual({ failure: 'credential-rejected', ok: false });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
  });

  describe('a half override (web and API on different hosts)', () => {
    const WEB_ONLY = { baseUrl: 'https://ghe.corp', organizationName: 'acme', repoName: 'api' };
    const API_ONLY = {
      apiUrl: 'https://ghe.corp/api/v3',
      organizationName: 'acme',
      repoName: 'api',
    };

    it.each([
      ['web only', WEB_ONLY],
      ['API only', API_ONLY],
      ['web only with an installation', { ...WEB_ONLY, installationId: '777' }],
      ['API only with an installation', { ...API_ONLY, installationId: '777' }],
    ])('fails clone, API and permission calls: %s', async (_n, repo) => {
      vi.mocked(resolveGitHubConfig).mockResolvedValue(instance(APP) as never);
      try {
        await expect(provider.cloneCredentials(repo as never)).rejects.toMatchObject({
          nonRetryable: true,
          type: 'REPO_HOST_MISCONFIGURED',
        });
        await expect(
          provider.fetchFileContent(repo as never, 'package.json')
        ).rejects.toMatchObject({ type: 'REPO_HOST_MISCONFIGURED' });
        await expect(provider.repoPermission(repo as never, 'octocat')).resolves.toEqual({
          failure: 'credential-rejected',
          ok: false,
        });
      } finally {
        vi.mocked(resolveGitHubConfig)
          .mockReset()
          .mockResolvedValue(instance() as never);
      }
      expect(requireGitHubToken).not.toHaveBeenCalled();
      expect(resolveGitHubToken).not.toHaveBeenCalled();
    });

    it('attaches no token, and mints none, when fetching CI logs', async () => {
      vi.mocked(resolveGitHubConfig).mockResolvedValue(instance(APP) as never);
      try {
        for (const repo of [WEB_ONLY, API_ONLY]) {
          // The instance's own origin and the repository's own origin alike.
          for (const url of [
            'https://github.com/acme/api/runs/1',
            'https://ghe.corp/acme/api/runs/1',
          ]) {
            fetchMock.mockClear();
            const out = await provider.fetchCiLogs(url, {
              ...repo,
              installationId: '777',
            } as never);
            expect(out).toContain('different hosts');
            expect(fetchMock).not.toHaveBeenCalled();
          }
        }
      } finally {
        vi.mocked(resolveGitHubConfig)
          .mockReset()
          .mockResolvedValue(instance() as never);
      }
      expect(resolveGitHubToken).not.toHaveBeenCalled();
    });

    it("refuses even a launcher's own token", async () => {
      vi.mocked(currentRunLauncherId).mockResolvedValue('user-1');
      vi.mocked(resolveUserCredential).mockResolvedValue({
        apiUrl: 'https://api.github.com',
        baseUrl: 'https://ghe.corp',
        token: 'ghp_user',
      });
      await expect(
        provider.cloneCredentials({ ...WEB_ONLY, connectionId: 'conn-1' } as never)
      ).rejects.toMatchObject({ type: 'REPO_HOST_MISCONFIGURED' });
    });

    it('treats the github.com web/API pair as one host', async () => {
      const creds = await provider.cloneCredentials({
        apiUrl: 'https://api.github.com',
        baseUrl: 'https://github.com',
        organizationName: 'acme',
        repoName: 'api',
      });
      expect(creds.token).toBe('ghp_tok');
    });

    it('treats a <tenant>.ghe.com pair as one host, reached by its own installation', async () => {
      vi.mocked(resolveGitHubConfig).mockResolvedValueOnce(instance(APP) as never);
      const creds = await provider.cloneCredentials({
        apiUrl: 'https://api.acme.ghe.com',
        baseUrl: 'https://acme.ghe.com',
        installationId: '777',
        organizationName: 'acme',
        repoName: 'api',
      });
      expect(creds.token).toBe('ghp_tok');
    });
  });

  it('adds the likely fix to the host-mismatch message', async () => {
    await expect(provider.cloneCredentials(GHE as never)).rejects.toMatchObject({
      message: expect.stringContaining("set the GitHub integration's web and API URLs to ghe.corp"),
    });
  });

  it("sends its own installation's token only to the repository's own origins for CI logs", async () => {
    const ghe = { ...GHE, installationId: '777' };
    vi.mocked(resolveGitHubConfig)
      .mockResolvedValueOnce(instance(APP) as never)
      .mockResolvedValueOnce(instance(APP) as never);
    const logs = (url: string) => provider.fetchCiLogs(url, ghe as never);
    // The instance's own origin is trusted by the instance, but the token
    // minted here is the GHE installation's.
    await logs('https://github.com/acme/api/runs/7');
    expect(lastFetch().init.headers).not.toHaveProperty('Authorization');
    await logs('https://ghe.corp/acme/api/runs/7');
    expect(lastFetch().init.headers).toMatchObject({ Authorization: 'Bearer ghp_tok' });
  });
});
