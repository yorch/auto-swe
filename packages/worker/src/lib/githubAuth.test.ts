import { RepositoryNotVisibleError } from '@auto-swe/shared/lib/githubInstallation';
import type { ResolvedGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { describe, expect, it, vi } from 'vitest';

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@auto-swe/shared/lib/githubInstallation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auto-swe/shared/lib/githubInstallation')>();
  return { ...actual, resolveGitHubToken: resolve };
});

import { requireGitHubToken } from './githubAuth.js';

describe('requireGitHubToken', () => {
  it('fails without retrying when the installation cannot see the repository', async () => {
    resolve.mockRejectedValueOnce(new RepositoryNotVisibleError('old-name', '777'));
    await expect(requireGitHubToken({} as ResolvedGitHubConfig, {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'REPO_NOT_VISIBLE_TO_INSTALLATION',
    });
  });

  it('leaves any other mint failure retryable', async () => {
    resolve.mockRejectedValueOnce(new Error('GitHub App installation token request failed: 502'));
    const err = await requireGitHubToken({} as ResolvedGitHubConfig, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty('nonRetryable', true);
    expect(String(err)).toContain('502');
  });
});
