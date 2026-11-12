// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const h = vi.hoisted(() => ({
  data: {} as { data?: unknown[]; sources?: unknown[] },
  error: null as Error | null,
  mutate: vi.fn(),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => false }));
vi.mock('@/hooks/useRepositoryTeams', () => ({
  useRepositoryTeams: () => [{ id: 'team-1', name: 'Payments' }],
}));
vi.mock('@/hooks/useRepositories', () => ({
  useGitHubAvailableRepos: () => ({ data: h.data, error: h.error, isLoading: false }),
  useImportGitHubRepos: () => ({ isPending: false, mutateAsync: h.mutate }),
}));

import { ImportFromGitHubModal } from './ImportFromGitHubModal';

function repo(name: string, extra: Partial<GitHubRepoInfo> = {}): GitHubRepoInfo {
  return {
    access: 'readable',
    alreadyImported: false,
    apiUrl: '',
    defaultBranch: 'main',
    description: null,
    githubApiUrl: null,
    githubUrl: null,
    htmlUrl: '',
    installationAccount: 'acme',
    installationId: 'install-1',
    language: null,
    name,
    org: 'acme',
    ...extra,
  };
}
beforeAll(() => stubDialogPrototype());
beforeEach(() => {
  h.data = {
    data: [
      repo('api'),
      repo('web', { access: 'unchecked' }),
      repo('imported', { alreadyImported: true }),
    ],
    sources: [
      {
        error: 'Installation could not be listed.',
        githubUrl: 'https://ghe.example',
        installationAccount: 'Enterprise',
        installationId: 'broken',
      },
    ],
  };
  h.error = null;
  h.mutate.mockReset().mockResolvedValue([
    { organizationName: 'acme', repoName: 'api', status: 'created' },
    {
      message: 'GitHub read access required',
      organizationName: 'acme',
      repoName: 'web',
      status: 'failed',
    },
  ]);
});
afterEach(cleanup);

describe('GitHub batch import modal', () => {
  it('selects multiple repos, including unchecked rows, and displays independent results', async () => {
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    const submit = screen.getByRole('button', { name: /Import .*repositories/ });
    expect(submit).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'Select acme/imported' })).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByText('Access unchecked')).toBeTruthy();
    expect(screen.getByText(/Enterprise.*Installation could not be listed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select acme/api' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select acme/web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 repositories' }));
    await waitFor(() => expect(screen.getByText('Import results')).toBeTruthy());
    expect(h.mutate).toHaveBeenCalledWith({
      repos: [
        {
          defaultBranch: 'main',
          installationId: 'install-1',
          organizationName: 'acme',
          repoName: 'api',
        },
        {
          defaultBranch: 'main',
          installationId: 'install-1',
          organizationName: 'acme',
          repoName: 'web',
        },
      ],
      teamId: 'team-1',
    });
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('GitHub read access required')).toBeTruthy();
  });
  it('preserves selections while searching and supports deselection', () => {
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select acme/api' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'web' } });
    expect(screen.queryByRole('checkbox', { name: 'Select acme/api' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Import 1 repositories' })).toHaveProperty(
      'disabled',
      false
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select acme/api' }));
    expect(screen.getByRole('button', { name: /Import .*repositories/ })).toHaveProperty(
      'disabled',
      true
    );
  });
  it('keeps repositories with the same name on different hosts independently selectable', async () => {
    h.data.data = [
      repo('api'),
      repo('api', { githubUrl: 'https://ghe.example', installationId: 'install-2' }),
    ];
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    for (const box of screen.getAllByRole('checkbox')) {
      fireEvent.click(box);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 repositories' }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalled());
    expect(
      h.mutate.mock.calls[0][0].repos.map((r: { installationId: string }) => r.installationId)
    ).toEqual(['install-1', 'install-2']);
  });
  it('caps selection at 50', () => {
    h.data.data = Array.from({ length: 51 }, (_, i) => repo(`r${i}`));
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes.slice(0, 50)) {
      fireEvent.click(box);
    }
    expect(boxes[50]).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Import 50 repositories' })).toBeTruthy();
  });
  it('shows empty state without enabling import', () => {
    h.data = { data: [], sources: [] };
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    expect(screen.getByText('No repositories found')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import .*repositories/ })).toHaveProperty(
      'disabled',
      true
    );
  });
  it('shows request errors without discarding selections', async () => {
    h.mutate.mockRejectedValue(new Error('Network unavailable'));
    render(<ImportFromGitHubModal onClose={() => {}} open />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 repositories' }));
    await waitFor(() => expect(screen.getByText('Network unavailable')).toBeTruthy());
    expect(screen.getByRole('checkbox', { name: 'Select acme/api' })).toHaveProperty(
      'checked',
      true
    );
  });
});
