// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { withQuery } from '@/test/rtl-helpers';

const auth = vi.hoisted(() => ({
  myTeams: [] as string[],
  orgRole: 'ORG_MEMBER',
  role: 'ENGINEER',
  teamRole: 'ENGINEER',
}));
const repos = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/connections',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (select: (state: { user: { role: string } }) => unknown) =>
    select({ user: { role: auth.role } }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useAdminTeamIds: () => new Set(auth.teamRole === 'ADMIN' ? ['t1'] : []),
  useLedTeamIds: () => new Set(auth.role === 'LEAD' ? ['t1'] : []),
  useTeams: (options?: { memberOnly?: boolean }) => ({
    data: options?.memberOnly
      ? auth.myTeams.map((id) => ({ id }))
      : [{ id: 't1', myRole: auth.role === 'LEAD' ? 'LEAD' : auth.teamRole, orgId: 'o1' }],
  }),
}));
vi.mock('@/hooks/useAdmin', () => ({
  useUserOrgs: () => ({ data: [{ id: 'o1', role: auth.orgRole }] }),
}));
vi.mock('@/hooks/useRepositories', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMyCredentials: () => ({ data: { credentials: [], enabled: false } }),
  useRepositories: () => ({
    data: repos.list,
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
  it.each(['ADMIN', 'LEAD', 'ENGINEER'])(
    'offers onboarding only to eligible setup authors: %s',
    (role) => {
      auth.role = role;
      auth.teamRole = 'ADMIN';
      repos.list = [
        {
          _count: { activeWorkflows: 0 },
          id: 'r1',
          isActive: true,
          name: 'api',
          organizationName: 'acme',
          repoName: 'api',
          team: { id: 't1', name: 'Payments', slug: 'payments' },
          type: 'git_repo',
        },
      ];
      try {
        render(withQuery(<ConnectionsPage />));
        fireEvent.click(screen.getByRole('button', { name: /More actions for acme\/api/ }));
        expect(Boolean(screen.queryByRole('menuitem', { name: 'Run onboarding' }))).toBe(
          role !== 'ENGINEER'
        );
      } finally {
        repos.list = [];
        auth.role = 'ENGINEER';
        auth.teamRole = 'ENGINEER';
      }
    }
  );
  it('runs onboarding from the row menu and shows launch failure', async () => {
    auth.role = 'ADMIN';
    repos.list = [
      {
        _count: { activeWorkflows: 0 },
        id: 'r1',
        isActive: true,
        name: 'api',
        organizationName: 'acme',
        repoName: 'api',
        team: { id: 't1', name: 'Payments', slug: 'payments' },
        type: 'git_repo',
      },
    ];
    const post = vi.spyOn(api, 'fetch').mockRejectedValue(new Error('Onboarding launch refused'));
    try {
      render(withQuery(<ConnectionsPage />));
      fireEvent.click(screen.getByRole('button', { name: /More actions for acme\/api/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Run onboarding' }));
      expect(await screen.findByText('Onboarding launch refused')).toBeTruthy();
    } finally {
      post.mockRestore();
      repos.list = [];
      auth.role = 'ENGINEER';
    }
  });
  it.each(['team', 'organization'])('allows an ENGINEER who manages the %s', (scope) => {
    auth.role = 'ENGINEER';
    auth.teamRole = scope === 'team' ? 'LEAD' : 'ENGINEER';
    auth.orgRole = scope === 'organization' ? 'ORG_ADMIN' : 'ORG_MEMBER';
    try {
      render(withQuery(<ConnectionsPage />));
      expect(screen.getAllByRole('button', { name: 'Import from GitHub' })).toHaveLength(2);
      expect(screen.queryByRole('link', { name: 'GitHub App setup' })).toBeNull();
    } finally {
      auth.teamRole = 'ENGINEER';
      auth.orgRole = 'ORG_MEMBER';
    }
  });
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

  it('shows who owns a repository and blocks, with a reason, what the caller cannot manage', () => {
    auth.role = 'LEAD';
    auth.myTeams = ['t1'];
    const base = {
      _count: { activeWorkflows: 0 },
      defaultBranch: 'main',
      description: null,
      isActive: true,
      language: null,
      name: 'api',
      organizationName: 'acme',
      type: 'git_repo',
    };
    repos.list = [
      {
        ...base,
        id: 'r1',
        repoName: 'api',
        team: { id: 't1', name: 'Payments', slug: 'payments' },
      },
      { ...base, id: 'r2', repoName: 'ui', team: { id: 't2', name: 'Design', slug: 'design' } },
    ];
    try {
      render(withQuery(<ConnectionsPage />));
      const edits = screen.getAllByRole('button', { name: /^Edit acme\/(api|ui)/ });
      const blocked = edits.filter((b) => b.getAttribute('aria-disabled') === 'true');
      expect(blocked).toHaveLength(1);
      expect(blocked[0]?.getAttribute('aria-label')).toMatch(/ui/);
      const reason = document.getElementById(blocked[0]?.getAttribute('aria-describedby') ?? '');
      expect(reason?.textContent).toBe(
        'Only leads of Design or an administrator can edit this repository.'
      );
      expect(screen.getAllByTestId('owner-chip').map((c) => c.textContent)).toEqual([
        'owned by Design',
      ]);
    } finally {
      repos.list = [];
      auth.myTeams = [];
    }
  });

  it('does not tell an ENGINEER that their own team owns a read-only repository', () => {
    auth.role = 'ENGINEER';
    auth.myTeams = ['t1'];
    repos.list = [
      {
        _count: { activeWorkflows: 0 },
        defaultBranch: 'main',
        description: null,
        id: 'r1',
        isActive: true,
        language: null,
        name: 'api',
        organizationName: 'acme',
        repoName: 'api',
        team: { id: 't1', name: 'Payments', slug: 'payments' },
        type: 'git_repo',
      },
    ];
    try {
      render(withQuery(<ConnectionsPage />));
      expect(screen.queryByTestId('owner-chip')).toBeNull();
      expect(screen.getByText(/Read-only for you/)).toBeTruthy();
    } finally {
      repos.list = [];
      auth.myTeams = [];
    }
  });

  it('shows Share and Deactivate disabled with the owner named for a caller who cannot manage', () => {
    auth.role = 'LEAD';
    auth.myTeams = ['t1'];
    repos.list = [
      {
        _count: { activeWorkflows: 0 },
        defaultBranch: 'main',
        description: null,
        id: 'r2',
        isActive: true,
        language: null,
        name: 'ui',
        organizationName: 'acme',
        repoName: 'ui',
        team: { id: 't2', name: 'Design', slug: 'design' },
        type: 'git_repo',
      },
    ];
    try {
      render(withQuery(<ConnectionsPage />));
      fireEvent.click(screen.getByRole('button', { name: /More actions for acme\/ui/ }));
      for (const name of ['Share with teams', 'Deactivate']) {
        const item = screen.getByRole('menuitem', { name });
        expect(item.getAttribute('aria-disabled')).toBe('true');
        expect(
          document.getElementById(item.getAttribute('aria-describedby') ?? '')?.textContent
        ).toBe('Only leads of Design or an administrator can do this.');
      }
    } finally {
      repos.list = [];
      auth.myTeams = [];
    }
  });

  it('leaves Share and Deactivate enabled for a lead of the owning team', () => {
    auth.role = 'LEAD';
    auth.myTeams = ['t1'];
    repos.list = [
      {
        _count: { activeWorkflows: 0 },
        defaultBranch: 'main',
        description: null,
        id: 'r1',
        isActive: true,
        language: null,
        name: 'api',
        organizationName: 'acme',
        repoName: 'api',
        team: { id: 't1', name: 'Payments', slug: 'payments' },
        type: 'git_repo',
      },
    ];
    try {
      render(withQuery(<ConnectionsPage />));
      fireEvent.click(screen.getByRole('button', { name: /More actions for acme\/api/ }));
      expect(
        screen.getByRole('menuitem', { name: 'Deactivate' }).getAttribute('aria-disabled')
      ).toBeNull();
    } finally {
      repos.list = [];
      auth.myTeams = [];
    }
  });
});
