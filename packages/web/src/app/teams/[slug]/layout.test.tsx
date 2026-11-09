// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function gateway(
  memberTeams: ReturnType<typeof team>[],
  extras: Record<string, () => unknown> = {}
) {
  return setupFetchMock({
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

beforeEach(() => {
  resetNavigation('', '/teams/payments');
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
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
    expect(screen.getByText('you: Lead')).toBeTruthy();
    expect(screen.getByText('tab content')).toBeTruthy();
  });

  it('resolves the slug through the member list only', async () => {
    const spy = gateway([team('payments', 'Payments', 'LEAD')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(spy.mock.calls.map(([u]) => String(u))).toEqual(
      expect.arrayContaining([expect.stringContaining('/api/v1/teams?member=true')])
    );
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
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe(
      '/teams/payments/settings'
    );
  });

  it('hides Settings from an engineer but keeps Members', async () => {
    gateway([team('payments', 'Payments', 'ENGINEER')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Members' })).toBeTruthy();
  });

  it('judges Settings by the team role, not the platform role', async () => {
    // A platform LEAD who is only an ENGINEER on this team.
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    gateway([team('payments', 'Payments', 'ENGINEER')]);
    renderLayout('payments');
    await screen.findByRole('heading', { name: 'Payments' });
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('offers a platform ADMIN Settings, and any team they can list', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
    gateway([], {
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
});
