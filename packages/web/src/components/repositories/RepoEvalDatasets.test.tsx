// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  datasets: [] as Array<Record<string, unknown>>,
  link: vi.fn(),
}));
vi.mock('@/hooks/useRepositories', () => ({
  useLinkRepoEvalDataset: () => ({ isPending: false, mutate: hooks.link }),
  useRepoEvalDatasets: () => ({ data: hooks.datasets, isError: false, isLoading: false }),
}));

import { RepoEvalDatasets } from './RepoEvalDatasets';

afterEach(() => {
  cleanup();
  hooks.link.mockReset();
});

describe('RepoEvalDatasets', () => {
  it('shows nothing when the team has no eval datasets', () => {
    hooks.datasets = [];
    const { container } = render(<RepoEvalDatasets disabled={false} repositoryId="repo-1" />);
    expect(container.textContent).toBe('');
  });

  it('links an unlinked dataset and unlinks a linked one', () => {
    hooks.datasets = [
      { id: 'd1', linked: true, name: 'Smoke', slug: 'smoke', usesRepository: null },
      {
        id: 'd2',
        linked: false,
        name: 'Regression',
        slug: 'regression',
        usesRepository: { id: 'r2', name: 'other-repo' },
      },
    ];
    render(<RepoEvalDatasets disabled={false} repositoryId="repo-1" />);
    expect(screen.getByText("Uses other-repo's secrets")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink eval dataset Smoke' }));
    expect(hooks.link).toHaveBeenCalledWith({ datasetId: 'd1', linked: false }, expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Link eval dataset Regression' }));
    expect(hooks.link).toHaveBeenCalledWith({ datasetId: 'd2', linked: true }, expect.anything());
  });

  it('disables the buttons without edit rights', () => {
    hooks.datasets = [
      { id: 'd1', linked: false, name: 'Smoke', slug: 'smoke', usesRepository: null },
    ];
    render(<RepoEvalDatasets disabled repositoryId="repo-1" />);
    expect(
      (screen.getByRole('button', { name: 'Link eval dataset Smoke' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
