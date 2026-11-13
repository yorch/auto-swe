// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  remove: vi.fn(),
  save: vi.fn(),
  secrets: [{ lastFour: 'cdef', name: 'NPM_TOKEN', updatedAt: '2026-11-06T12:00:00Z' }] as Array<
    Record<string, unknown>
  >,
}));
vi.mock('@/hooks/useRepositories', () => ({
  useDeleteSetupSecret: () => ({ isPending: false, mutate: hooks.remove }),
  useSaveSetupSecret: () => ({ isPending: false, mutate: hooks.save }),
  useSetupSecrets: () => ({ data: hooks.secrets, isError: false, isLoading: false }),
}));

import { RepoSetupSecrets } from './RepoSetupSecrets';

describe('RepoSetupSecrets', () => {
  beforeEach(() => {
    hooks.save.mockReset();
    hooks.remove.mockReset();
  });

  it('lists each secret by name and last four characters only', () => {
    render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
    expect(screen.getByText('NPM_TOKEN')).toBeTruthy();
    expect(screen.getByText('••••cdef')).toBeTruthy();
  });

  it('saves a named value from a password field, then clears it', () => {
    render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
    const value = screen.getByLabelText('Value') as HTMLInputElement;
    expect(value.type).toBe('password');
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'PIP_TOKEN' } });
    fireEvent.change(value, { target: { value: 'pypi-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(hooks.save).toHaveBeenCalledWith(
      { name: 'PIP_TOKEN', value: 'pypi-secret' },
      expect.anything()
    );
  });

  it('refuses a name that is not an environment variable name', () => {
    render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'pip-token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } });
    expect(
      (screen.getByRole('button', { name: 'Save secret' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/environment variable name/)).toBeTruthy();
  });

  it('deletes a secret by name', () => {
    render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete secret NPM_TOKEN' }));
    expect(hooks.remove).toHaveBeenCalledWith('NPM_TOKEN', expect.anything());
  });

  describe('team-granted secrets', () => {
    const repoSecret = { lastFour: 'cdef', name: 'NPM_TOKEN', updatedAt: '2026-11-06T12:00:00Z' };
    const teamSecret = (name: string, shadowed: boolean) => ({
      lastFour: 'wxyz',
      name,
      shadowed,
      source: 'team',
      updatedAt: '2026-11-07T12:00:00Z',
    });

    afterEach(() => {
      hooks.secrets = [repoSecret];
    });

    it('lists a team secret read-only under From team, with no delete button', () => {
      hooks.secrets = [repoSecret, teamSecret('PIP_TOKEN', false)];
      render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
      expect(screen.getByText('PIP_TOKEN')).toBeTruthy();
      expect(screen.getByText('From team')).toBeTruthy();
      expect(screen.getByText('••••wxyz')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Delete secret PIP_TOKEN' })).toBeNull();
      // The repository's own secret keeps its delete button.
      expect(screen.getByRole('button', { name: 'Delete secret NPM_TOKEN' })).toBeTruthy();
      expect(screen.queryByText(/shadowed by repository secret/)).toBeNull();
    });

    it('notes when a repository secret of the same name shadows the team secret', () => {
      hooks.secrets = [repoSecret, teamSecret('NPM_TOKEN', true)];
      render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
      expect(screen.getByText('From team')).toBeTruthy();
      expect(screen.getByText('shadowed by repository secret')).toBeTruthy();
    });

    it('keeps rows without a source as repository secrets, unchanged', () => {
      hooks.secrets = [{ ...repoSecret, shadowed: false, source: 'repo' }];
      render(<RepoSetupSecrets disabled={false} repositoryId="repo-1" />);
      expect(screen.queryByText('From team')).toBeNull();
      expect(screen.getByRole('button', { name: 'Delete secret NPM_TOKEN' })).toBeTruthy();
    });
  });
});
