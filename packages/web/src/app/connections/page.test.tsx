// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withQuery } from '@/test/rtl-helpers';

const auth = vi.hoisted(() => ({ role: 'ENGINEER' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (state: { user: { role: string } }) => unknown) =>
    select({ user: { role: auth.role } }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useLedTeamIds: () => new Set(auth.role === 'LEAD' ? ['t1'] : []),
}));
vi.mock('@/hooks/useRepositories', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMyCredentials: () => ({ data: { credentials: [], enabled: false } }),
  useRepositories: () => ({
    data: [],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    meta: { total: 0 },
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useRepoDependencies', () => ({
  useRepoDependencySuggestions: () => ({ data: [] }),
  useTriggerRepoDependencyScan: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('@/components/setup/SetupReadiness', () => ({ SetupBanner: () => null }));

import ConnectionsPage from './page';

afterEach(cleanup);

describe('Connections page', () => {
  it('defines a connection, and offers the GitHub App guide only to administrators', () => {
    auth.role = 'ENGINEER';
    const { unmount } = render(withQuery(<ConnectionsPage />));
    expect(screen.getByText(/is a configured link to an outside system/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'GitHub App setup' })).toBeNull();
    expect(screen.getByText(/Ask a lead of the owning team or an administrator/)).toBeTruthy();
    expect(screen.getByText(/the platform needs a GitHub App installation or token/)).toBeTruthy();
    unmount();

    auth.role = 'LEAD';
    const lead = render(withQuery(<ConnectionsPage />));
    expect(screen.queryByRole('link', { name: 'GitHub App setup' })).toBeNull();
    lead.unmount();

    auth.role = 'ADMIN';
    render(withQuery(<ConnectionsPage />));
    expect(screen.getByRole('link', { name: 'GitHub App setup' }).getAttribute('href')).toContain(
      'github-app-setup'
    );
  });
});
