// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTeamSpace } from '@/components/teams/space/TeamSpaceContext';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import TeamSpaceLayout from './layout';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));

function params(slug: string) {
  const value = { slug };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

const team = (slug: string, name: string, myRole: string | null) => ({
  _count: { memberships: 3, repositories: 2 },
  defaultPersonaPrompt: null,
  description: '',
  id: `id-${slug}`,
  myRole,
  name,
  orgId: 'org-1',
  orgName: 'Acme Corp',
  slug,
});

/** What the server says the caller holds on the team `id-payments`, by kind of person. */
const LEAD_CAPS = ['team.settings.manage', 'team.attention.read', 'team.members.manage'] as const;
const standing = (
  caps: readonly string[],
  role: string | null = 'LEAD',
  authority = 'team-role'
) => ({
  organizations: [],
  platformCapabilities: [],
  platformRole: '',
  teams: [
    {
      capabilities: caps.map((key) => ({ authority, key })),
      name: 'Payments',
      orgId: 'org-1',
      role,
      slug: 'payments',
      teamId: 'id-payments',
    },
  ],
});
const PLATFORM_ADMIN = {
  organizations: [],
  platformCapabilities: ['platform.users.manage'],
  platformRole: '',
  teams: [],
};

function gateway(
  memberTeams: ReturnType<typeof team>[],
  permissions: object = standing(LEAD_CAPS),
  extras: Record<string, () => unknown> = {}
) {
  return setupFetchMock({
    'GET /api/v1/me/permissions': () => permissions,
    'GET /api/v1/me/preferences': () => ({ preferences: {} }),
    'GET /api/v1/teams': () => ({ data: memberTeams }),
    'PATCH /api/v1/me/preferences': () => ({ preferences: {} }),
    ...extras,
  });
}

function renderLayout(slug: string) {
  render(
    withQuery(
      <TeamSpaceLayout params={params(slug)}>
        <p>tab content</p>
      </TeamSpaceLayout>
    )
  );
}

function BudgetProbe() {
  const { canManageBudget } = useTeamSpace();
  return <p>budget: {String(canManageBudget)}</p>;
}

beforeEach(() => {
  resetNavigation('', '/teams/payments');
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'USER', sub: 'me' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('team space layout', () => {
  it('shows the team, its organization and the caller’s own role, with the tab content', async () => {
    gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('you: Team lead')).toBeTruthy();
    expect(screen.getByText('tab content')).toBeTruthy();
  });

  it('resolves the slug through the member list first, then the full visible list', async () => {
    const spy = gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    const urls = spy.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(
      expect.arrayContaining([expect.stringContaining('/api/v1/teams?member=true')])
    );
    expect(urls.some((u) => u.endsWith('/api/v1/teams'))).toBe(true);
  });

  it('opens a team the caller administers without belonging to, with no role badge', async () => {
    gateway([], standing(['team.settings.manage'], null, 'org-admin'), {
      'GET /api/v1/teams': () => ({ data: [team('payments', 'Payments', null)] }),
    });
    renderLayout('payments');
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(screen.queryByText(/you:/)).toBeNull();
    expect(screen.getByText('tab content')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  it('renders the same not-found for a visible-list miss as for an unknown slug', async () => {
    gateway([], standing([], null, 'org-admin'), {
      'GET /api/v1/teams': () => ({ data: [team('ops', 'Ops', null)] }),
    });
    renderLayout('hr-confidential');
    expect(await screen.findByText('Page not found')).toBeTruthy();
    const first = document.body.textContent;
    cleanup();
    renderLayout('does-not-exist');
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(document.body.textContent).toBe(first);
    expect(screen.queryByText('tab content')).toBeNull();
  });

  it('renders the ordinary not-found page for a team the caller is not in, hinting nothing', async () => {
    gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('hr-confidential');
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.queryByText('tab content')).toBeNull();
    expect(screen.queryByText(/hr-confidential/)).toBeNull();
  });

  it('offers a lead every tab including Settings', async () => {
    gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    const nav = screen.getByRole('navigation', { name: 'Team sections' });
    expect(Array.from(nav.querySelectorAll('a')).map((a) => a.textContent)).toEqual([
      'Overview',
      'Work',
      'Automations',
      'Reports',
      'Knowledge',
      'Members',
      'Manage',
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/teams/payments/settings'
    );
  });

  it('hides Settings from a member but keeps Members', async () => {
    gateway([team('payments', 'Payments', 'MEMBER')], standing([], 'MEMBER'));
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Members' })).toBeTruthy();
  });

  it('offers Manage to a lead, and not to a member', async () => {
    gateway([team('payments', 'Payments', 'MEMBER')], standing([], 'MEMBER'));
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    expect((await screen.findByRole('link', { name: 'Manage' })).getAttribute('href')).toBe(
      '/teams/payments/manage'
    );
  });

  it('offers an organization admin who is a plain member of the team Settings, from the server’s answer', async () => {
    // Governance reaches an organization admin without a team role; Manage (a lead's) does not.
    gateway(
      [team('payments', 'Payments', 'MEMBER')],
      standing(['team.settings.manage', 'team.budget.manage'], 'MEMBER', 'org-admin')
    );
    renderLayout('payments');
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull();
  });

  it('does not offer Settings to a member whose answer lists no governance capability', async () => {
    gateway([team('payments', 'Payments', 'MEMBER')], standing([], 'MEMBER'));
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('does not render the tabs before the permissions have answered', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gateway([team('payments', 'Payments', 'LEAD')]);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/v1/me/permissions')) {
        await gate;
      }
      return inner(input, init);
    });
    renderLayout('payments');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('navigation', { name: 'Team sections' })).toBeNull();
    release();
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
  });

  describe('an organization admin with no team role', () => {
    const orgAdmin = {
      organizations: [{ capabilities: [], name: 'Acme', orgId: 'org-1', role: 'ADMIN' }],
      platformCapabilities: [],
      platformRole: '',
      teams: [],
    };
    const narrowedAnswer = standing(['team.settings.manage'], null, 'org-admin');

    function withNarrowed(handle: (narrowed: () => Promise<Response>) => Promise<Response>) {
      gateway([], orgAdmin, {
        'GET /api/v1/teams': () => ({ data: [team('payments', 'Payments', null)] }),
      });
      const inner = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/api/v1/me/permissions?teamId=')) {
          return handle(async () => Response.json(narrowedAnswer));
        }
        return inner(input, init);
      });
    }

    it('shows the loading shape, not a missing tab or not-found, while the per-team answer is pending', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      withNarrowed(async (answer) => {
        await gate;
        return answer();
      });
      renderLayout('payments');
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('navigation', { name: 'Team sections' })).toBeNull();
      expect(screen.queryByText('tab content')).toBeNull();
      release();
      expect(await screen.findByRole('link', { name: 'Settings' })).toBeTruthy();
    });

    it('shows the failure of the per-team answer instead of a tab bar without Settings', async () => {
      withNarrowed(async () => new Response('{}', { status: 500 }));
      renderLayout('payments');
      expect(await screen.findByText(/Could not load team permissions/)).toBeTruthy();
      expect(screen.queryByRole('navigation', { name: 'Team sections' })).toBeNull();
      expect(screen.queryByText('tab content')).toBeNull();
    });
  });

  it('offers a platform admin Settings, and any team they can list', async () => {
    gateway([], PLATFORM_ADMIN, {
      'GET /api/v1/teams': () => ({ data: [team('payments', 'Payments', null)] }),
    });
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    // Not a member, so there is no role to claim.
    expect(screen.queryByText(/you:/)).toBeNull();
  });

  it('marks the tab of the current path', async () => {
    resetNavigation('', '/teams/payments/work');
    gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.getByRole('link', { name: 'Work' }).getAttribute('aria-current')).toBe('page');
  });

  it('remembers the visit as the last team, once', async () => {
    const spy = gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/me/preferences', 'PATCH')).toEqual({ lastTeamSlug: 'payments' })
    );
    expect(
      spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    ).toHaveLength(1);
  });

  it('says a lead may manage the budget only when the server lists the capability', async () => {
    gateway([team('payments', 'Payments', 'LEAD')]);
    render(
      withQuery(
        <TeamSpaceLayout params={params('payments')}>
          <BudgetProbe />
        </TeamSpaceLayout>
      )
    );
    expect(await screen.findByText('budget: false')).toBeTruthy();
  });

  it('lets whoever holds team.budget.manage there manage the budget', async () => {
    gateway(
      [team('payments', 'Payments', 'LEAD')],
      standing([...LEAD_CAPS, 'team.budget.manage'], 'ADMIN')
    );
    render(
      withQuery(
        <TeamSpaceLayout params={params('payments')}>
          <BudgetProbe />
        </TeamSpaceLayout>
      )
    );
    expect(await screen.findByText('budget: true')).toBeTruthy();
  });
});
