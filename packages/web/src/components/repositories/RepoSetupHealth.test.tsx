// @vitest-environment jsdom

import type { RepoSetupBlockerSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  blockers: [] as RepoSetupBlockerSummary[],
  dismiss: vi.fn(),
  isError: false,
  isLoading: false,
}));
vi.mock('@/hooks/useRepositories', () => ({
  useDismissSetupBlocker: () => ({ isPending: false, mutate: hooks.dismiss }),
  useSetupBlockers: () => ({
    data: hooks.blockers,
    isError: hooks.isError,
    isLoading: hooks.isLoading,
  }),
}));

import { RepoSetupHealth } from './RepoSetupHealth';

beforeEach(() => {
  hooks.blockers = [];
  hooks.dismiss.mockReset();
  hooks.isError = false;
  hooks.isLoading = false;
});

describe('RepoSetupHealth', () => {
  it('shows the empty state', () => {
    render(<RepoSetupHealth disabled={false} repositoryId="repo" />);
    expect(screen.getByText('No open setup blockers')).toBeTruthy();
  });

  it('shows loading and error states rather than an empty success state', () => {
    hooks.isLoading = true;
    const view = render(<RepoSetupHealth disabled={false} repositoryId="repo" />);
    expect(screen.getByText('Loading setup blockers…')).toBeTruthy();
    hooks.isLoading = false;
    hooks.isError = true;
    view.rerender(<RepoSetupHealth disabled={false} repositoryId="repo" />);
    expect(screen.getByText('Setup blockers could not be loaded.')).toBeTruthy();
  });

  it('lists diagnostics and dismisses by id, respecting read-only mode', () => {
    hooks.blockers = [
      {
        detail: 'sh: foo: not found',
        firstSeenAt: '2026-11-12T12:00:00Z',
        id: 'blocker',
        kind: 'missing_tool',
        lastSeenAt: '2026-11-12T12:00:00Z',
        lastWorkflowId: null,
        occurrences: 3,
        remedy: 'Install foo.',
        resolvedAt: null,
        step: 'install',
        subject: 'foo',
      },
    ];
    const view = render(<RepoSetupHealth disabled={false} repositoryId="repo" />);
    expect(screen.getByText(/Missing tool/)).toBeTruthy();
    expect(screen.getByText('Step: install')).toBeTruthy();
    expect(screen.getByText('Install foo.')).toBeTruthy();
    expect(screen.getByText(/3 occurrences/)).toBeTruthy();
    expect(screen.getByText('Detail').closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Missing tool foo' }));
    expect(hooks.dismiss).toHaveBeenCalledWith('blocker', expect.anything());
    view.rerender(<RepoSetupHealth disabled repositoryId="repo" />);
    expect(
      (screen.getByRole('button', { name: 'Dismiss Missing tool foo' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it('reports dismissal failure', () => {
    hooks.blockers = [
      {
        detail: '',
        firstSeenAt: '',
        id: 'blocker',
        kind: 'internal',
        lastSeenAt: '2026-11-12T12:00:00Z',
        lastWorkflowId: null,
        occurrences: 1,
        remedy: 'Retry.',
        resolvedAt: null,
        step: null,
        subject: '',
      },
    ];
    hooks.dismiss.mockImplementation((_id, options) =>
      options.onError(new Error('Dismiss failed'))
    );
    render(<RepoSetupHealth disabled={false} repositoryId="repo" />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(screen.getByText('Dismiss failed')).toBeTruthy();
  });
});
