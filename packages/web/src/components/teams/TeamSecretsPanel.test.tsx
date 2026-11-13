// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  grants: vi.fn(),
  remove: vi.fn(),
  save: vi.fn(),
  secrets: [] as {
    grantedConnectionIds: string[];
    lastFour: string;
    name: string;
    updatedAt: string;
  }[],
}));
vi.mock('@/hooks/useTeamSecrets', () => ({
  useDeleteTeamSecret: () => ({
    isPending: false,
    mutate: hooks.remove,
    mutateAsync: hooks.remove,
  }),
  useSaveTeamSecret: () => ({ isPending: false, mutate: hooks.save }),
  useSetTeamSecretGrants: () => ({ isPending: false, mutate: hooks.grants }),
  useTeamSecrets: () => ({ data: hooks.secrets, isError: false, isLoading: false }),
}));

import { stubDialogPrototype } from '@/test/rtl-helpers';
import { TeamSecretsPanel } from './TeamSecretsPanel';

const repositories = [
  { id: 'c-1', isActive: true, organizationName: 'acme', repoName: 'api' },
  { id: 'c-2', isActive: true, organizationName: 'acme', repoName: 'web' },
];

describe('TeamSecretsPanel', () => {
  beforeEach(() => {
    stubDialogPrototype();
    hooks.save.mockReset();
    hooks.remove.mockReset();
    hooks.grants.mockReset();
    hooks.secrets = [
      {
        grantedConnectionIds: ['c-1'],
        lastFour: 'cdef',
        name: 'NPM_TOKEN',
        updatedAt: '2026-11-06T12:00:00Z',
      },
    ];
  });

  it('lists each secret by name and last four characters only', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    expect(screen.getByText('NPM_TOKEN')).toBeTruthy();
    expect(screen.getByText('••••cdef')).toBeTruthy();
    expect(screen.getByText('1 repo')).toBeTruthy();
    // The value field is write-only: never prefilled, always a password input.
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('');
  });

  it('states the reach of a team secret', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    expect(
      screen.getByText(/reaches only repositories you grant it to, and only in workspace setup/)
    ).toBeTruthy();
    expect(
      screen.getByText(/A repository's own secret of the same name takes precedence/)
    ).toBeTruthy();
  });

  it('saves a name and value from a password field, sending the value once, then clears it', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    const value = screen.getByLabelText('Value') as HTMLInputElement;
    expect(value.type).toBe('password');
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'PIP_TOKEN' } });
    fireEvent.change(value, { target: { value: 'pypi-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(hooks.save).toHaveBeenCalledTimes(1);
    expect(hooks.save).toHaveBeenCalledWith(
      { name: 'PIP_TOKEN', value: 'pypi-secret' },
      expect.anything()
    );
  });

  it('refuses a value shorter than the minimum', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'PIP_TOKEN' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'short' } });
    expect(
      (screen.getByRole('button', { name: 'Save secret' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/at least 8 characters/)).toBeTruthy();
  });

  it('refuses a name that is not an environment variable name', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'pip-token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'long-enough-value' } });
    expect(
      (screen.getByRole('button', { name: 'Save secret' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/environment variable name/)).toBeTruthy();
  });

  it('deletes a secret only after confirmation', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete team secret NPM_TOKEN' }));
    expect(hooks.remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete secret' }));
    expect(hooks.remove).toHaveBeenCalledWith('NPM_TOKEN');
  });

  it('shows only the team repositories as grant choices and submits the chosen set', () => {
    render(<TeamSecretsPanel repositories={repositories} teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Repositories' }));
    const api = screen.getByRole('checkbox', { name: 'acme/api' }) as HTMLInputElement;
    const web = screen.getByRole('checkbox', { name: 'acme/web' }) as HTMLInputElement;
    expect(api.checked).toBe(true);
    expect(web.checked).toBe(false);
    const save = screen.getByRole('button', {
      name: 'Save grants for NPM_TOKEN',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(web);
    fireEvent.click(api);
    fireEvent.click(save);
    expect(hooks.grants).toHaveBeenCalledWith(
      { connectionIds: ['c-2'], name: 'NPM_TOKEN' },
      expect.anything()
    );
  });

  it('says so when the team owns no repository to grant to', () => {
    render(<TeamSecretsPanel repositories={[]} teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Repositories' }));
    expect(screen.getByText(/owns no repositories/)).toBeTruthy();
  });
});
