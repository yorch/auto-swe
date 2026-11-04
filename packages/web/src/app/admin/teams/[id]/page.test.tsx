// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import TeamDetailPage from './page';

// The allowlist and agent-library sections have their own tests and fetch their own data.
vi.mock('@/components/teams/ShellAllowlistEditor', () => ({ ShellAllowlistEditor: () => null }));
vi.mock('@/components/teams/EgressAllowlistEditor', () => ({ EgressAllowlistEditor: () => null }));
vi.mock('@/components/teams/EventEndpointsCard', () => ({ EventEndpointsCard: () => null }));
vi.mock('@/components/teams/TeamAgentLibrarySection', () => ({
  TeamAgentLibrarySection: () => null,
}));

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

function resolvedParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
}

const team = (persona: string | null) => ({
  data: {
    defaultPersonaPrompt: persona,
    description: null,
    id: TEAM_ID,
    memberships: [],
    name: 'Payments',
    repositories: [],
    sharedRepositories: [],
  },
});

beforeEach(() => {
  resetNavigation('', `/admin/teams/${TEAM_ID}`);
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

function renderPage() {
  render(withQuery(<TeamDetailPage params={resolvedParams({ id: TEAM_ID })} />));
}

describe('TeamDetailPage persona', () => {
  it('prefills the current persona and keeps Save disabled until it changes', async () => {
    const spy = setupFetchMock({
      [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.'),
      [`PATCH /api/v1/teams/${TEAM_ID}`]: () => team('Be kind.'),
    });
    renderPage();
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
    renderPage();
    const box = (await screen.findByLabelText('Persona')) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save persona' }));
    expect(await screen.findByText(/use "Clear persona"/)).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'PATCH')).toBe(
      false
    );
  });
});

describe('TeamDetailPage tabs', () => {
  const mockTeam = () =>
    setupFetchMock({ [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.') });

  it('shows the overview first and moves to a section through the URL', async () => {
    mockTeam();
    renderPage();
    await screen.findByLabelText('Persona');
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox policy' }));
    expect(nav.replace.at(-1)).toBe(`/admin/teams/${TEAM_ID}?tab=sandbox`);
    expect(screen.queryByLabelText('Persona')).toBeNull();
  });

  it('offers no sandbox or service-principal section to someone who cannot manage them', async () => {
    useAuthStore.setState({ isAuthenticated: true, user: { role: 'ENGINEER', sub: 'me' } });
    mockTeam();
    renderPage();
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Sandbox policy' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Service principals' })).toBeNull();
  });
});
