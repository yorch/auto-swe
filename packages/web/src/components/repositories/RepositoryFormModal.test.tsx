// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RepositoryFormModal } from './RepositoryFormModal';

beforeEach(stubDialogPrototype);
afterEach(() => vi.unstubAllGlobals());

const TEAM_FIXTURE = {
  _count: { memberships: 1, repositories: 0 },
  description: '',
  id: 't1',
  name: 'platform',
  slug: 'platform',
};

describe('RepositoryFormModal — create', () => {
  it('POSTs the form fields and includes the team id', async () => {
    const onClose = vi.fn();
    const spy = setupFetchMock({
      '/api/v1/repositories': () => ({ data: { id: 'r-new' } }),
      '/api/v1/teams': () => ({ data: [TEAM_FIXTURE] }),
    });

    render(
      withQuery(<RepositoryFormModal mode={{ kind: 'create' }} onClose={onClose} open={true} />)
    );

    // The modal's useEffect re-syncs state when `teams` resolves async; the
    // submit button is `disabled={!teamId}` until that re-sync runs. Wait for
    // the team option to be selected before interacting, otherwise the click
    // hits a disabled button and silently no-ops.
    await waitFor(() => {
      const combo = screen.getByRole('combobox', { name: /team/i }) as HTMLSelectElement;
      expect(combo.value).toBe('t1');
    });

    fireEvent.change(screen.getByLabelText(/organization/i), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/repo name/i), { target: { value: 'payments-api' } });
    // defaultBranch defaults to 'main'; executor image stays blank → undefined
    fireEvent.click(screen.getByRole('button', { name: /add repository/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(bodyOf(spy, '/api/v1/repositories', 'POST')).toEqual({
      defaultBranch: 'main',
      organizationName: 'acme',
      repoName: 'payments-api',
      teamId: 't1',
    });
  });
});

describe('RepositoryFormModal — edit', () => {
  it('PATCHes nullable fields explicitly as null when cleared', async () => {
    const onClose = vi.fn();
    const repo = {
      _count: { activeWorkflows: 0 },
      config: null,
      consolidationEnabled: true,
      defaultBranch: 'main',
      description: 'old description',
      executorImage: 'node:24-alpine',
      id: 'r1',
      isActive: true,
      language: 'typescript',
      name: null,
      organizationName: 'acme',
      repoName: 'payments-api',
      team: { id: 't1', name: 'platform', slug: 'platform' },
      type: 'git_repo',
    };
    const spy = setupFetchMock({
      '/api/v1/repositories/r1': () => ({ data: { ...repo, language: null } }),
      '/api/v1/teams': () => ({ data: [TEAM_FIXTURE] }),
    });

    render(
      withQuery(<RepositoryFormModal mode={{ kind: 'edit', repo }} onClose={onClose} open={true} />)
    );

    // Wait for both initial-sync passes to complete: the first sets language
    // from `initial`, the second (when `teams` resolves) re-runs the same
    // useEffect. Settle on the team value (which only changes after teams load)
    // so the next field change isn't immediately stomped by the re-sync.
    await waitFor(() => {
      const combo = screen.getByRole('combobox', { name: /team/i }) as HTMLSelectElement;
      expect(combo.value).toBe('t1');
    });
    fireEvent.change(screen.getByLabelText(/language/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // Empty strings should be sent as null on the edit path so the gateway
    // clears the column. This is the contract that lets admins remove a
    // previously-set executor image / language / description.
    const body = bodyOf(spy, '/api/v1/repositories/r1', 'PATCH') as { language: unknown };
    expect(body.language).toBeNull();
  });
});
