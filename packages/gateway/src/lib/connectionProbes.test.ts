import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('@auto-swe/shared/lib/guardedDispatcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/guardedDispatcher')>()),
  createGuardedFetch: () => fetchMock,
}));

const identity = vi.fn();
const mintToken = vi.fn();
vi.mock('@auto-swe/shared/lib/githubInstallation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/githubInstallation')>()),
  fetchGitHubAppIdentity: (...args: unknown[]) => identity(...args),
  resolveGitHubToken: (...args: unknown[]) => mintToken(...args),
}));

const repositoryHostsAllowed = vi.fn();
const resolveUserCredential = vi.fn();
vi.mock('@auto-swe/shared/lib/connectionCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/connectionCredential')>()),
  repositoryHostsAllowed: (...args: unknown[]) => repositoryHostsAllowed(...args),
  resolveUserCredential: (...args: unknown[]) => resolveUserCredential(...args),
}));

const resolvePlatformCredential = vi.fn();
vi.mock('@auto-swe/shared/lib/githubHostCredential', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/githubHostCredential')>()),
  resolvePlatformCredential: (...args: unknown[]) => resolvePlatformCredential(...args),
}));

const resolveGitHubConfig = vi.fn();
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubApproverAppConfig: vi.fn(),
  resolveGitHubConfig: () => resolveGitHubConfig(),
}));

const {
  probeAppInstallation,
  probeGitHubCredentialSet,
  probePackageRegistry,
  probePagerDutyConnection,
  probeRepositoryAccess,
  probeApproverApp,
} = await import('./connectionProbes.js');
const { CredentialUnreadableError } = await import('@auto-swe/shared/lib/connectionCredential');
const { GitHubTokenMissingError } = await import('@auto-swe/shared/lib/githubInstallation');

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status });
const empty = (status: number) => new Response(null, { status });

const API = 'https://api.github.com';

beforeEach(() => {
  vi.resetAllMocks();
  repositoryHostsAllowed.mockResolvedValue({ ok: true });
  resolveGitHubConfig.mockResolvedValue({ apiUrl: API, baseUrl: 'https://github.com' });
});

describe('probeGitHubCredentialSet', () => {
  it('fails a set with nothing in it without making a request', async () => {
    const result = await probeGitHubCredentialSet(
      { appId: null, appPrivateKey: null, token: null },
      API,
      fetchMock
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('No token or GitHub App is set.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the login a PAT authenticates as, with no redirect followed', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { login: 'octocat' }));
    const result = await probeGitHubCredentialSet(
      { appId: null, appPrivateKey: null, token: 'ghp_secret' },
      API,
      fetchMock
    );
    expect(result).toMatchObject({ detail: 'Token authenticates as octocat.', ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/user`);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_secret');
  });

  it('gives a rejected token fixed wording and never echoes the response body', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Bad credentials ghp_secret' }));
    const result = await probeGitHubCredentialSet(
      { appId: null, appPrivateKey: null, token: 'ghp_secret' },
      API,
      fetchMock
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('GitHub returned 401: the credential was rejected.');
    expect(JSON.stringify(result)).not.toContain('ghp_secret');
  });

  it('does not pass a network error message through', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:443'));
    const result = await probeGitHubCredentialSet(
      { appId: null, appPrivateKey: null, token: 'ghp_secret' },
      API,
      fetchMock
    );
    expect(result).toMatchObject({ detail: 'The host could not be reached.', ok: false });
    expect(JSON.stringify(result)).not.toContain('10.0.0.7');
  });

  it('reports a valid App and how many accounts it is installed on', async () => {
    identity.mockResolvedValueOnce({ id: '42', ok: true, slug: 'acme-bot' });
    fetchMock.mockResolvedValueOnce(json(200, [{ id: 1 }, { id: 2 }]));
    const result = await probeGitHubCredentialSet(
      { appId: '42', appPrivateKey: PEM, token: null },
      API,
      fetchMock
    );
    expect(result).toMatchObject({
      detail: 'App acme-bot is valid and installed on 2 accounts.',
      ok: true,
    });
  });

  it('fails an App that is installed nowhere, since it could reach nothing', async () => {
    identity.mockResolvedValueOnce({ id: '42', ok: true, slug: 'acme-bot' });
    fetchMock.mockResolvedValueOnce(json(200, []));
    const result = await probeGitHubCredentialSet(
      { appId: '42', appPrivateKey: PEM, token: null },
      API,
      fetchMock
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not installed on any account');
  });

  it('distinguishes a rejected App key from an unreachable host', async () => {
    identity.mockResolvedValueOnce({ ok: false, reason: 'rejected' });
    const rejected = await probeGitHubCredentialSet(
      { appId: '42', appPrivateKey: PEM, token: null },
      API,
      fetchMock
    );
    expect(rejected.detail).toBe('GitHub rejected the App id and private key.');
    identity.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    const unreachable = await probeGitHubCredentialSet(
      { appId: '42', appPrivateKey: PEM, token: null },
      API,
      fetchMock
    );
    expect(unreachable.detail).toBe('The host could not be reached.');
  });

  it('fails when both a token and an App are set and only one works', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { login: 'octocat' }));
    identity.mockResolvedValueOnce({ ok: false, reason: 'rejected' });
    const result = await probeGitHubCredentialSet(
      { appId: '42', appPrivateKey: PEM, token: 'ghp_x' },
      API,
      fetchMock
    );
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => c.ok)).toEqual([true, false]);
  });
});

describe('probeAppInstallation', () => {
  const config = { appId: '42', appPrivateKey: PEM } as never;

  it('stops at a rejected App key', async () => {
    identity.mockResolvedValueOnce({ ok: false, reason: 'rejected' });
    const result = await probeAppInstallation(config, '999', API, fetchMock);
    expect(result.ok).toBe(false);
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('reports a failed token mint without the underlying message', async () => {
    identity.mockResolvedValueOnce({ id: '42', ok: true, slug: 'acme-bot' });
    mintToken.mockRejectedValueOnce(new Error('request failed: 404 Not Found jwt=eyJsecret'));
    const result = await probeAppInstallation(config, '999', API, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('installation 999');
    expect(JSON.stringify(result)).not.toContain('eyJsecret');
  });

  it('counts the repositories the installation can reach', async () => {
    identity.mockResolvedValueOnce({ id: '42', ok: true, slug: 'acme-bot' });
    mintToken.mockResolvedValueOnce('ghs_install');
    fetchMock.mockResolvedValueOnce(json(200, { total_count: 1 }));
    const result = await probeAppInstallation(config, '999', API, fetchMock);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Installation 999 can reach 1 repository.');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/installation/repositories?per_page=1`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_install');
  });
});

describe('probePackageRegistry', () => {
  const base = {
    allowPrivateNetwork: false,
    authKind: 'bearer',
    ecosystem: 'npm',
    token: 'npm_secret',
    upstreamUrl: 'https://registry.example.com/',
  };

  it('pings an npm registry and sends the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(empty(200));
    const result = await probePackageRegistry(base, fetchMock);
    expect(result).toMatchObject({
      detail: 'The registry answered and accepted the credential.',
      ok: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://registry.example.com/-/ping');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer npm_secret');
  });

  it('spells basic auth the way the registry proxy does', async () => {
    fetchMock.mockResolvedValueOnce(empty(200));
    await probePackageRegistry({ ...base, authKind: 'basic', token: 'user:pass' }, fetchMock);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`
    );
  });

  it('asks a non-npm registry at its root', async () => {
    fetchMock.mockResolvedValueOnce(empty(200));
    await probePackageRegistry({ ...base, ecosystem: 'go' }, fetchMock);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://registry.example.com/');
  });

  it('fails a rejected token', async () => {
    fetchMock.mockResolvedValueOnce(empty(401));
    const result = await probePackageRegistry(base, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('credential was rejected');
    expect(JSON.stringify(result)).not.toContain('npm_secret');
  });

  it('says a registry with no token needs one when it answers 401', async () => {
    fetchMock.mockResolvedValueOnce(empty(401));
    const result = await probePackageRegistry({ ...base, token: null }, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('needs one');
  });

  it('does not claim the credential was verified when the probe path is 404', async () => {
    fetchMock.mockResolvedValueOnce(empty(404));
    const result = await probePackageRegistry(base, fetchMock);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no endpoint that confirms the credential');
  });

  it('fails a server error', async () => {
    fetchMock.mockResolvedValueOnce(empty(503));
    const result = await probePackageRegistry(base, fetchMock);
    expect(result).toMatchObject({
      detail: 'The registry returned 503: the server reported an error.',
      ok: false,
    });
  });

  it('refuses a private upstream URL without the opt-in, before any request', async () => {
    const result = await probePackageRegistry(
      { ...base, upstreamUrl: 'https://169.254.169.254/' },
      fetchMock
    );
    expect(result).toMatchObject({ detail: 'The saved upstream URL is not allowed.', ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not pass a network error message through', async () => {
    fetchMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND registry.internal'));
    const result = await probePackageRegistry(base, fetchMock);
    expect(result).toMatchObject({ detail: 'The host could not be reached.', ok: false });
  });
});

describe('probeRepositoryAccess', () => {
  const repo = {
    defaultBranch: 'main',
    githubApiUrl: null,
    githubUrl: null,
    id: 'repo-1',
    installation: null,
    organizationName: 'acme',
    repoName: 'api',
    scmProvider: 'github',
  };
  const prisma = {} as never;
  const instance = { config: { apiUrl: API }, scope: 'instance' };

  beforeEach(() => {
    resolvePlatformCredential.mockResolvedValue(instance);
    mintToken.mockResolvedValue('ghs_platform');
    resolveUserCredential.mockResolvedValue(null);
  });

  it('fails a connection with no GitHub repository, without a request', async () => {
    const result = await probeRepositoryAccess(
      prisma,
      { ...repo, organizationName: null },
      'user-1'
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes a gitlab repository with no credential: nothing is resolved, minted or sent', async () => {
    const result = await probeRepositoryAccess(
      prisma,
      { ...repo, scmProvider: 'gitlab' },
      'user-1'
    );
    expect(result.ok).toBe(false);
    expect(resolvePlatformCredential).not.toHaveBeenCalled();
    expect(resolveUserCredential).not.toHaveBeenCalled();
    expect(mintToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails a repository whose URL is not on an approved host', async () => {
    repositoryHostsAllowed.mockResolvedValueOnce({ ok: false, url: 'https://evil.example' });
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.detail).toBe("The repository's GitHub URL is not on an approved host.");
    expect(JSON.stringify(result)).not.toContain('evil.example');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes when the platform credential can push and the default branch exists', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { pull: true, push: true } }))
      .mockResolvedValueOnce(json(200, { name: 'main' }));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      'Platform credential: repository',
      'Platform credential: default branch',
    ]);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(`${API}/repos/acme/api/branches/main`);
  });

  it("asks for a token scoped to the repository, as a run's would be", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(200, {}));
    await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(resolvePlatformCredential).toHaveBeenCalledWith(
      expect.objectContaining({ organizationName: 'acme', repoName: 'api' }),
      expect.anything()
    );
  });

  it('fails a credential that can read but not push, since runs open pull requests', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { pull: true, push: false } }))
      .mockResolvedValueOnce(json(200, {}));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('cannot open pull requests');
  });

  it('accepts a credential that reports no permission level, and says so', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 1 })).mockResolvedValueOnce(json(200, {}));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(true);
    expect(result.checks[0]?.detail).toContain('does not report a permission level');
  });

  it('reports a repository the credential cannot see, without distinguishing absent from hidden', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { message: 'Not Found' }));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      'GitHub returned 404: it was not found, or the credential cannot see it.'
    );
  });

  it('reports a missing default branch with the branch name to fix', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(404, {}));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Default branch main was not found');
  });

  it('names a host that has no platform credential', async () => {
    resolvePlatformCredential.mockResolvedValueOnce({ host: 'ghe.corp', scope: 'mismatch' });
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.detail).toContain('No platform credential is configured for ghe.corp');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a missing platform token as configuration, not a GitHub error', async () => {
    mintToken.mockRejectedValueOnce(new GitHubTokenMissingError());
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.detail).toBe('No platform token or GitHub App installation is configured.');
  });

  it('does not echo the reason a token could not be minted', async () => {
    mintToken.mockRejectedValueOnce(new Error('404 Not Found for installation 7 jwt=eyJsecret'));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('eyJsecret');
  });

  it("also checks the caller's own saved token, and never returns it", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(200, {}));
    resolveUserCredential.mockResolvedValueOnce({
      apiUrl: API,
      baseUrl: 'https://github.com',
      token: 'ghp_user_token',
    });
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toContain('Your saved token: repository');
    expect(resolveUserCredential).toHaveBeenCalledWith(prisma, {
      connectionId: 'repo-1',
      userId: 'user-1',
    });
    expect(JSON.stringify(result)).not.toContain('ghp_user_token');
  });

  it('tells the caller to save an undecryptable token again', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(200, {}));
    resolveUserCredential.mockRejectedValueOnce(new CredentialUnreadableError(new Error('x')));
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('Your saved token can no longer be decrypted. Save it again.');
  });

  it('still checks the caller token when the platform credential fails', async () => {
    resolvePlatformCredential.mockResolvedValueOnce({ host: 'ghe.corp', scope: 'mismatch' });
    fetchMock
      .mockResolvedValueOnce(json(200, { permissions: { push: true } }))
      .mockResolvedValueOnce(json(200, {}));
    resolveUserCredential.mockResolvedValueOnce({
      apiUrl: API,
      baseUrl: 'https://github.com',
      token: 'ghp_user_token',
    });
    const result = await probeRepositoryAccess(prisma, repo, 'user-1');
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => c.ok)).toEqual([false, true, true]);
  });
});

describe('probeApproverApp', () => {
  it('is covered by the route tests; here it only fails safely when unconfigured', async () => {
    const { resolveGitHubApproverAppConfig } = await import('@auto-swe/shared/lib/systemConfig');
    vi.mocked(resolveGitHubApproverAppConfig).mockResolvedValueOnce(null);
    const result = await probeApproverApp();
    expect(result).toMatchObject({
      detail: 'The approver App is not fully configured.',
      ok: false,
    });
  });
});

describe('probePagerDutyConnection', () => {
  const users = (emails: string[]) =>
    json(200, { users: emails.map((email, i) => ({ email, id: `P${i}` })) });

  it('passes when the key is accepted and a user has the fromEmail', async () => {
    fetchMock.mockResolvedValueOnce(users(['Other@example.com', 'OnCall@Example.com']));
    const result = await probePagerDutyConnection('pd-key', 'oncall@example.com', fetchMock);
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.pagerduty.com/users?limit=25&query=oncall%40example.com');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token token=pd-key');
    expect(init.redirect).toBe('error');
  });

  it('fails the email check when no user has exactly that email', async () => {
    fetchMock.mockResolvedValueOnce(users(['oncall@example.com.evil']));
    const result = await probePagerDutyConnection('pd-key', 'oncall@example.com', fetchMock);
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => [c.name, c.ok])).toEqual([
      ['API key', true],
      ['From email', false],
    ]);
  });

  it('fails without a fromEmail, since notes need one', async () => {
    fetchMock.mockResolvedValueOnce(users([]));
    const result = await probePagerDutyConnection('pd-key', undefined, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/No fromEmail/);
  });

  it('reports a rejected key with fixed wording, never the body', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: 'secret detail pd-key' } }));
    const result = await probePagerDutyConnection('pd-key', 'oncall@example.com', fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('PagerDuty refused the request: the credential was rejected.');
  });

  it('reports an unreachable PagerDuty without the error text', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.7:443'));
    const result = await probePagerDutyConnection('pd-key', 'oncall@example.com', fetchMock);
    expect(result.ok).toBe(false);
    expect(result.detail).not.toMatch(/10\.0\.0\.7/);
  });
});
