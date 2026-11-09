// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
