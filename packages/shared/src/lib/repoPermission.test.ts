import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./systemConfig.js', () => ({
  resolveGitHubConfig: vi.fn(async () => ({
    apiUrl: 'https://api.github.com',
    baseUrl: 'https://github.com',
    token: 'ghp_platform',
  })),
}));
vi.mock('./githubInstallation.js', () => ({
  resolveGitHubToken: vi.fn(async () => 'ghp_platform'),
}));
vi.mock('./githubPermission.js', () => ({
  fetchRepoPermission: vi.fn(async () => ({ ok: true, permission: 'write' })),
}));

import { resolveGitHubToken } from './githubInstallation.js';
import { fetchRepoPermission } from './githubPermission.js';
import { lookupRepoPermission } from './repoPermission.js';

const repo = { installation: null, organizationName: 'acme', repoName: 'api' };

describe('lookupRepoPermission — the API override is a credential destination', () => {
  beforeEach(() => {
    vi.mocked(resolveGitHubToken).mockClear();
    vi.mocked(fetchRepoPermission).mockClear();
  });

  it('never resolves or sends a token to an untrusted API host', async () => {
    const lookup = await lookupRepoPermission(
      { ...repo, githubApiUrl: 'https://attacker.example/api/v3' },
      'octocat'
    );
    expect(lookup).toEqual({ failure: 'credential-rejected', ok: false });
    expect(resolveGitHubToken).not.toHaveBeenCalled();
    expect(fetchRepoPermission).not.toHaveBeenCalled();
  });

  it('asks the configured host when there is no override', async () => {
    await expect(lookupRepoPermission(repo, 'octocat')).resolves.toEqual({
      ok: true,
      permission: 'write',
    });
    expect(fetchRepoPermission).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: 'https://api.github.com', token: 'ghp_platform' })
    );
  });
});
