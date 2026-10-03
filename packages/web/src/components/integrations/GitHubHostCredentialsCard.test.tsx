// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubHostCredentialRow } from '@/hooks/useGithubHostCredentials';

const rows: GithubHostCredentialRow[] = [
  {
    appId: '42',
    appPrivateKeyLastFour: 'KEY-',
    createdAt: '2026-09-30T00:00:00Z',
    hasAppPrivateKey: true,
    hasToken: true,
    host: 'ghe.corp',
    id: 'row-1',
    tokenLastFour: 'abcd',
    updatedAt: '2026-09-30T00:00:00Z',
  },
];

const createMutate = vi.fn().mockResolvedValue({});
const updateMutate = vi.fn().mockResolvedValue({});
vi.mock('@/hooks/useGithubHostCredentials', () => ({
  useCreateGithubHostCredential: () => ({ isPending: false, mutateAsync: createMutate }),
  useDeleteGithubHostCredential: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useGithubHostCredentials: () => ({ data: rows, error: null, isError: false, isLoading: false }),
  useUpdateGithubHostCredential: () => ({ isPending: false, mutateAsync: updateMutate }),
}));

const { GitHubHostCredentialsCard } = await import('./GitHubHostCredentialsCard');

// jsdom implements <dialog> without showModal()/close().
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GitHubHostCredentialsCard', () => {
  it('lists each host with what is set, showing only last-fours', () => {
    render(<GitHubHostCredentialsCard />);
    expect(screen.getByText('ghe.corp')).toBeTruthy();
    expect(screen.getByText('PAT ••••abcd · App 42')).toBeTruthy();
  });

  it('adds credentials for a host, lowercasing it and sending only what was filled in', async () => {
    render(<GitHubHostCredentialsCard />);
    fireEvent.click(screen.getByText('Add host credentials'));
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: ' GHE.Other ' } });
    fireEvent.change(screen.getByLabelText('Personal access token'), {
      target: { value: 'ghp_x' },
    });
    fireEvent.click(screen.getByText('Add credentials'));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(createMutate).toHaveBeenCalledWith({ host: 'ghe.other', token: 'ghp_x' });
  });

  it('edits without resending secrets it did not change, and can clear the App', async () => {
    render(<GitHubHostCredentialsCard />);
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByLabelText('Remove the GitHub App'));
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    expect(updateMutate).toHaveBeenCalledWith({
      body: { appId: null, appPrivateKey: null },
      id: 'row-1',
    });
  });
});
