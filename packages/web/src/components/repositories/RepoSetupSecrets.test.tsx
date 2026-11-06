// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  remove: vi.fn(),
  save: vi.fn(),
  secrets: [{ lastFour: 'cdef', name: 'NPM_TOKEN', updatedAt: '2026-11-06T12:00:00Z' }],
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
});
