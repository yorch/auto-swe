// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamSettingsPanel } from './TeamSettingsPanel';

// The allowlist and agent-library sections have their own tests and fetch their own data.
vi.mock('@/components/teams/ShellAllowlistEditor', () => ({ ShellAllowlistEditor: () => null }));
vi.mock('@/components/teams/EgressAllowlistEditor', () => ({ EgressAllowlistEditor: () => null }));
vi.mock('@/components/teams/EventEndpointsCard', () => ({ EventEndpointsCard: () => null }));
vi.mock('@/components/teams/TeamAgentLibrarySection', () => ({
  TeamAgentLibrarySection: () => null,
}));

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

const summary = (myRole: 'ADMIN' | 'LEAD' | 'ENGINEER' | null) => ({
  _count: { memberships: 0, repositories: 0 },
  defaultPersonaPrompt: null,
  description: '',
  id: TEAM_ID,
  myRole,
  name: 'Payments',
  orgId: 'o',
  orgName: 'Acme',
  slug: 'payments',
});

const team = (persona: string | null) => ({
  data: {
    defaultPersonaPrompt: persona,
    description: null,
    id: TEAM_ID,
    memberships: [],
    name: 'Payments',
    repositories: [],
    sharedRepositories: [],
    slug: 'payments',
  },
});

beforeEach(() => {
  resetNavigation('', '/teams/payments/settings');
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

function renderPanel(role: 'ADMIN' | 'LEAD' | 'ENGINEER' | null = 'LEAD') {
  render(withQuery(<TeamSettingsPanel team={summary(role)} />));
}

describe('TeamSettingsPanel persona', () => {
  it('prefills the current persona and keeps Save disabled until it changes', async () => {
    const spy = setupFetchMock({
      [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.'),
      [`PATCH /api/v1/teams/${TEAM_ID}`]: () => team('Be kind.'),
    });
    renderPanel();
    const box = (await screen.findByLabelText('Persona')) as HTMLTextAreaElement;
    expect(box.value).toBe('Be terse.');
    const save = screen.getByRole('button', { name: 'Save persona' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'Be kind.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(bodyOf(spy, `/api/v1/teams/${TEAM_ID}`, 'PATCH')).toEqual({
        defaultPersonaPrompt: 'Be kind.',
      })
    );
  });

  it('never clears the persona through Save: an emptied box is refused', async () => {
    const spy = setupFetchMock({
      [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.'),
    });
    renderPanel();
    const box = (await screen.findByLabelText('Persona')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));
    expect(await screen.findByText(/use "Clear persona"/)).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false
    );
  });
});

describe('TeamSettingsPanel sections', () => {
  const mockTeam = () =>
    setupFetchMock({ [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.') });

  it('shows General first and moves to a section through the URL', async () => {
    mockTeam();
    renderPanel();
    await screen.findByLabelText('Persona');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox policy' }));
    expect(nav.replace.at(-1)).toBe('/teams/payments/settings?tab=sandbox');
    expect(screen.queryByLabelText('Persona')).toBeNull();
  });

  it('offers a team lead who is not a platform ADMIN neither sandbox nor service principals by rule', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mockTeam();
    renderPanel('LEAD');
    await screen.findByRole('tab', { name: 'General' });
    // Allowlists are platform-ADMIN only (teamPermissions), whatever the team role.
    expect(screen.queryByRole('tab', { name: 'Sandbox policy' })).toBeNull();
    // A platform LEAD who leads the team manages members and so service principals.
    expect(screen.getByRole('tab', { name: 'Service principals' })).toBeTruthy();
  });

  it('offers no member-management section when the team role is below lead', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mockTeam();
    renderPanel('ENGINEER');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'Service principals' })).toBeNull();
    expect(screen.queryByLabelText('Persona')).toBeNull();
  });
});

describe('TeamSettingsPanel budget and sharing', () => {
  const t = (id: string, name: string) => ({ id, name, slug: id });
  const mock = (extra: Record<string, () => unknown> = {}) =>
    setupFetchMock({
      [`GET /api/v1/teams/${TEAM_ID}`]: () => team(null),
      [`GET /api/v1/teams/${TEAM_ID}/budget`]: () => ({
        data: {
          budgetAlertThresholdPercent: null,
          monthlyBudgetUsdCents: null,
          monthSpendUsdCents: 100,
        },
      }),
      [`GET /api/v1/teams/${TEAM_ID}/budget/status`]: () => ({
        data: { alertThresholdPercent: null, percentUsed: null, scope: 'org', state: 'no_cap' },
      }),
      'GET /api/v1/platform/organizations': () => ({ data: [] }),
      'GET /api/v1/repositories': () => ({ data: [] }),
      ...extra,
    });

  it('offers the Budget tab to a team ADMIN who is not a platform admin', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock();
    renderPanel('ADMIN');
    expect(await screen.findByRole('tab', { name: 'Budget' })).toBeTruthy();
  });

  it('hides the Budget tab from a team LEAD, even a platform LEAD', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock();
    renderPanel('LEAD');
    await screen.findByRole('tab', { name: 'General' });
    // Let the org lookup settle: it must not grant the tab to a non-ORG_ADMIN.
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Budget' })).toBeNull());
  });

  it('offers the Budget tab to an ORG_ADMIN of the team’s organization only', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock({
      'GET /api/v1/platform/organizations': () => ({
        data: [
          { id: 'other', name: 'Other', role: 'ORG_ADMIN', slug: 'other' },
          { id: 'o', name: 'Acme', role: 'ORG_ADMIN', slug: 'acme' },
        ],
      }),
    });
    renderPanel('LEAD');
    expect(await screen.findByRole('tab', { name: 'Budget' })).toBeTruthy();
  });

  it('shows an ORG_ADMIN below team LEAD the Budget section alone', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
    mock({
      'GET /api/v1/platform/organizations': () => ({
        data: [{ id: 'o', name: 'Acme', role: 'ORG_ADMIN', slug: 'acme' }],
      }),
    });
    resetNavigation('tab=automation', '/teams/payments/settings');
    renderPanel('ENGINEER');
    expect(await screen.findByTestId('team-budget-section')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'General' })).toBeNull();
    expect(screen.queryByText('Shared with this team')).toBeNull();
  });

  it('does not grant the tab for ORG_ADMIN of a different organization', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock({
      'GET /api/v1/platform/organizations': () => ({
        data: [{ id: 'other', name: 'Other', role: 'ORG_ADMIN', slug: 'other' }],
      }),
    });
    renderPanel('LEAD');
    await screen.findByRole('tab', { name: 'General' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('tab', { name: 'Budget' })).toBeNull();
  });

  it('shows the Budget section with the Model configuration link to a platform ADMIN', async () => {
    mock();
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel('ADMIN');
    expect(await screen.findByTestId('team-budget-section')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Model configuration' })).toBeTruthy();
  });

  it('omits the Model configuration link for a team ADMIN who cannot reach the page', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock();
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel('ADMIN');
    await screen.findByTestId('team-budget-section');
    expect(screen.queryByRole('link', { name: 'Model configuration' })).toBeNull();
  });

  it('lets the owning team set who may launch on each shared repository', async () => {
    const owned = {
      id: 'r1',
      organizationName: 'acme',
      repoName: 'api',
      shares: [{ canLaunch: false, team: t('t2', 'Platform') }],
      team: t(TEAM_ID, 'Payments'),
    };
    mock({ 'GET /api/v1/repositories': () => ({ data: [owned] }) });
    renderPanel('LEAD');
    const card = await screen.findByTestId('shared-out');
    expect(
      within(card)
        .getByRole('switch', { name: 'Can launch work: Platform' })
        .getAttribute('aria-checked')
    ).toBe('false');
    expect(within(card).getByRole('button', { name: 'Revoke access for Platform' })).toBeTruthy();
  });

  it('shows no share management to a team member below lead', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'LEAD', sub: 'me' } });
    mock({
      'GET /api/v1/repositories': () => ({
        data: [
          {
            id: 'r1',
            organizationName: 'acme',
            repoName: 'api',
            shares: [{ canLaunch: true, team: t('t2', 'Platform') }],
            team: t(TEAM_ID, 'Payments'),
          },
        ],
      }),
    });
    renderPanel('ENGINEER');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByTestId('shared-out')).toBeNull();
  });

  it('puts a View only chip on repositories shared with this team without launch rights', async () => {
    const sharedIn = {
      canLaunch: false,
      id: 'r9',
      organizationName: 'acme',
      repoName: 'ui',
      team: t('own', 'Design'),
    };
    setupFetchMock({
      [`GET /api/v1/teams/${TEAM_ID}`]: () => ({
        data: { ...team(null).data, sharedRepositories: [sharedIn] },
      }),
    });
    renderPanel('LEAD');
    const chip = await screen.findByText('View only');
    expect(chip.closest('li')?.textContent).toContain('acme/ui');
    expect(chip.closest('li')?.textContent).toContain('from Design');
  });
});
