// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import GovernConfigGrantsPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  stubDialogPrototype();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

function mock(grants: unknown[] = []) {
  return setupFetchMock({
    'GET /api/v1/platform/config/grants': () => ({ data: grants }),
    'GET /api/v1/platform/config/grants/preview': () => ({
      data: {
        keyPattern: '*',
        keys: ['a.b', 'c.d'],
        settings: [
          { group: 'a', key: 'a.b', label: 'A', writeAccess: 'admin' },
          { group: 'c', key: 'c.d', label: 'C', writeAccess: 'grantable' },
        ],
        writeAccess: 'admin',
      },
    }),
    'GET /api/v1/platform/organizations/budget-alerts': () => ({ data: [] }),
    'GET /api/v1/teams': () => ({
      data: [{ id: TEAM_ID, name: 'Payments', orgId: 'o1', slug: 'payments' }],
    }),
    'GET /api/v1/users': () => ({ data: [] }),
    'POST /api/v1/platform/config/grants': () => ({ data: { id: 'g1' } }),
  });
}

/** Choose the "One team" scope and a team: the only scope a team role can be granted at. */
async function chooseTeamScope() {
  fireEvent.click(await screen.findByRole('button', { name: /Scope/ }));
  fireEvent.click(screen.getByRole('option', { name: 'One team' }));
  const team = await screen.findByRole('combobox', { name: /team/i });
  act(() => team.focus());
  fireEvent.change(team, { target: { value: 'Pay' } });
  fireEvent.click(await screen.findByRole('option', { name: /Payments/ }));
}

describe('config grants: broad grants', () => {
  it('asks for confirmation before creating a grant for every setting, and creates only after it', async () => {
    const spy = mock();
    render(withQuery(<GovernConfigGrantsPage />));
    await chooseTeamScope();
    fireEvent.change(await screen.findByLabelText(/Key pattern/), { target: { value: '*' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create grant' }));
    expect(await screen.findByText('Create a broad grant?')).toBeTruthy();
    expect(spy.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: 'Create grant' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(bodyOf(spy, '/api/v1/platform/config/grants')).toMatchObject({
        keyPattern: '*',
        role: 'LEAD',
        scope: 'TEAM',
        teamId: TEAM_ID,
      })
    );
  });

  it('labels the example chips as an action rather than a toggle', async () => {
    mock();
    render(withQuery(<GovernConfigGrantsPage />));
    const chip = await screen.findByRole('button', { name: 'Use pattern channel.*' });
    expect(chip.getAttribute('aria-pressed')).toBeNull();
  });
});

describe('config grants: a role grantee is a team role', () => {
  it('offers no team role on the whole platform, where the gateway would refuse it', async () => {
    mock();
    render(withQuery(<GovernConfigGrantsPage />));
    // The default scope is the whole platform: only a specific user can be granted there.
    // With no active users the picker says so; either way there is no team-role select.
    expect(await screen.findByText('No active users left to add')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Team role/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Grant to/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'A specific user',
    ]);
  });

  it('offers the team roles, with the labels people read, once the scope is a team', async () => {
    mock();
    render(withQuery(<GovernConfigGrantsPage />));
    await chooseTeamScope();
    fireEvent.click(await screen.findByRole('button', { name: /Team role/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'Team admin',
      'Team lead',
      'Team member',
    ]);
  });

  it('shows who may write what the pattern covers', async () => {
    mock();
    render(withQuery(<GovernConfigGrantsPage />));
    fireEvent.change(await screen.findByLabelText(/Key pattern/), { target: { value: '*' } });
    expect(await screen.findByText('a · platform admin')).toBeTruthy();
    expect(screen.getByText('c · platform admin or a grant')).toBeTruthy();
    expect(screen.getByText('Write access:')).toBeTruthy();
  });
});

describe('config grants: a grant that is already covered', () => {
  const WARNING = /An existing grant already covers this one/;
  const existing = (role: string) => ({
    createdAt: '2026-01-01T00:00:00.000Z',
    id: 'g0',
    keyPattern: 'channel.*',
    orgId: null,
    role,
    scope: 'TEAM',
    team: { name: 'Payments' },
    teamId: TEAM_ID,
    userId: null,
  });

  async function fillNewLeadGrant() {
    await chooseTeamScope();
    fireEvent.change(await screen.findByLabelText(/Key pattern/), {
      target: { value: 'channel.*' },
    });
  }

  it('warns when an existing grant names a lower role for the same pattern and team', async () => {
    mock([existing('MEMBER')]);
    render(withQuery(<GovernConfigGrantsPage />));
    await fillNewLeadGrant();
    expect(await screen.findByText(WARNING)).toBeTruthy();
  });

  it('warns when an existing grant names the same role', async () => {
    mock([existing('LEAD')]);
    render(withQuery(<GovernConfigGrantsPage />));
    await fillNewLeadGrant();
    expect(await screen.findByText(WARNING)).toBeTruthy();
  });

  it('does not warn when the existing grant names a higher role, which covers fewer people', async () => {
    mock([existing('ADMIN')]);
    render(withQuery(<GovernConfigGrantsPage />));
    await fillNewLeadGrant();
    // The existing grant has loaded into the table, so its absence of a warning is meaningful.
    await waitFor(() => expect(screen.getAllByText('channel.*')).toHaveLength(2));
    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
