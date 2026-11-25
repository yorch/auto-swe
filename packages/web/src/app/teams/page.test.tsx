// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/authStore';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import TeamsPage from './page';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ user: { role: 'USER', sub: 'me' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const team = (slug: string, name: string, myRole: string | null) => ({
  _count: { memberships: 2, repositories: 1 },
  description: '',
  id: `id-${slug}`,
  myRole,
  name,
  orgId: 'o1',
  orgName: 'Acme',
  slug,
});

const directory = (creatableOrgs: { id: string; name: string }[]) => ({
  creatableOrgs,
  nextCursor: null,
  teams: [],
});

describe('team creation entry', () => {
  it.each([
    [
      'an organization or platform admin, or a self-service member',
      [{ id: 'o1', name: 'Acme' }],
      true,
    ],
    ['a person the server names no organization for', [], false],
  ] as const)('%s: creation=%s', async (_who, creatable, allowed) => {
    setupFetchMock({
      '/api/v1/teams': () => ({ data: [] }),
      '/api/v1/teams/directory': () => directory([...creatable]),
    });
    render(withQuery(<TeamsPage />));
    await screen.findByText('No teams yet');
    if (allowed) {
      expect((await screen.findAllByRole('button', { name: 'New team' })).length).toBeGreaterThan(
        0
      );
      expect(screen.queryByText(/Organization admins and platform admins create teams/)).toBeNull();
    } else {
      // Let the directory answer before asserting that nothing was offered.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('button', { name: 'New team' })).toBeNull();
    }
  });
});

describe('My teams groups', () => {
  it('splits member teams from administered ones, each with a chip', async () => {
    setupFetchMock({
      '/api/v1/teams': () => ({
        data: [team('pay', 'Payments', 'LEAD'), team('ops', 'Operations', null)],
      }),
      '/api/v1/teams/directory': () => directory([]),
    });
    render(withQuery(<TeamsPage />));
    const member = await screen.findByRole('region', { name: 'Member' });
    expect(within(member).getByText('Payments')).toBeTruthy();
    expect(within(member).getByText('Team lead')).toBeTruthy();
    expect(within(member).queryByText('Operations')).toBeNull();
    const administered = screen.getByRole('region', { name: 'Administered' });
    expect(within(administered).getByText('Operations')).toBeTruthy();
    expect(within(administered).getByText('Org admin')).toBeTruthy();
  });
});

describe('a person in no team', () => {
  it('is offered the directory instead of a dead end', async () => {
    setupFetchMock({
      '/api/v1/teams': () => ({ data: [] }),
      '/api/v1/teams/directory': () => directory([]),
    });
    render(withQuery(<TeamsPage />));
    await screen.findByText('No teams yet');
    fireEvent.click(screen.getByRole('button', { name: 'Browse the directory' }));
    expect(screen.getByRole('tab', { name: 'Directory' }).getAttribute('aria-selected')).toBe(
      'true'
    );
  });
});
