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

import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { resolveGitHubToken } from '../githubAuth.js';
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

describe('GitHubScmProvider — repository host overrides are credential destinations', () => {
  const provider = new GitHubScmProvider();
  const repo = { organizationName: 'acme', repoName: 'api' };

  it('refuses to embed the token in a clone URL on an untrusted web host', async () => {
    await expect(
      provider.cloneCredentials({ ...repo, baseUrl: 'https://attacker.example' })
    ).rejects.toThrow(/untrusted/i);
  });

  it('refuses a clone when the API override is untrusted', async () => {
    await expect(
      provider.cloneCredentials({ ...repo, apiUrl: 'https://attacker.example/api/v3' })
    ).rejects.toThrow(/untrusted/i);
  });

  it('still builds a clone URL for github.com and a missing override', async () => {
    const creds = await provider.cloneCredentials({ ...repo, baseUrl: 'https://github.com' });
    expect(creds.cloneUrl).toBe('https://github.com/acme/api.git');
    await expect(provider.cloneCredentials(repo)).resolves.toMatchObject({
      cloneUrl: 'https://github.com/acme/api.git',
    });
  });

  it('answers a permission lookup against an untrusted API host with a failure, never a token', async () => {
    const lookup = await provider.repoPermission(
      { ...repo, apiUrl: 'https://attacker.example', installationId: '42' },
      'octocat'
    );
    expect(lookup).toEqual({ failure: 'credential-rejected', ok: false });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
