// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  data: undefined as unknown,
  mutate: vi.fn(),
}));
vi.mock('@/hooks/useRepositories', () => ({
  useRepositoryReviewRouting: () => ({ data: hooks.data, isError: false, isLoading: false }),
  useSetRepositoryReviewRouting: () => ({ isPending: false, mutate: hooks.mutate }),
}));

import { RepoReviewRouting, toOverride } from './RepoReviewRouting';

afterEach(() => {
  cleanup();
  hooks.mutate.mockReset();
});

const effective = {
  humanAboveLines: 0,
  humanMinRisk: 'HIGH',
  humanPaths: ['infra/**'],
  quickReviewMaxLines: 100,
  skipWhenBotApproved: true,
};

describe('toOverride', () => {
  it('leaves blank fields out so they inherit', () => {
    expect(
      toOverride({
        humanAboveLines: '',
        humanMinRisk: '',
        humanPaths: ' \n',
        quickReviewMaxLines: '',
        skipWhenBotApproved: '',
      })
    ).toEqual({});
  });

  it('reads numbers, one glob per line and the bot-approval switch', () => {
    expect(
      toOverride({
        humanAboveLines: '400',
        humanMinRisk: 'STANDARD',
        humanPaths: 'db/**\n  auth/**  \n',
        quickReviewMaxLines: '0',
        skipWhenBotApproved: 'false',
      })
    ).toEqual({
      humanAboveLines: 400,
      humanMinRisk: 'STANDARD',
      humanPaths: ['db/**', 'auth/**'],
      quickReviewMaxLines: 0,
      skipWhenBotApproved: false,
    });
  });
});

describe('RepoReviewRouting', () => {
  it('shows the stored override and the value in force, and saves an edited override', async () => {
    hooks.data = { effective, override: { humanPaths: ['db/**'] } };
    render(<RepoReviewRouting disabled={false} repositoryId="r1" />);
    const paths = (await screen.findByLabelText(
      'Paths that always ask for a person'
    )) as HTMLTextAreaElement;
    expect(paths.value).toBe('db/**');
    expect(screen.getByText(/In force: infra\/\*\*/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ask above (lines)'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save review routing' }));
    expect(hooks.mutate).toHaveBeenCalledWith(
      { humanAboveLines: 300, humanPaths: ['db/**'] },
      expect.anything()
    );
  });

  it('clears the override with null when every field is blank', async () => {
    hooks.data = { effective, override: {} };
    render(<RepoReviewRouting disabled={false} repositoryId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save review routing' }));
    expect(hooks.mutate).toHaveBeenCalledWith(null, expect.anything());
  });

  it('disables editing for someone who may not write it', async () => {
    hooks.data = { effective, override: {} };
    render(<RepoReviewRouting disabled repositoryId="r1" />);
    const save = (await screen.findByRole('button', {
      name: 'Save review routing',
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
