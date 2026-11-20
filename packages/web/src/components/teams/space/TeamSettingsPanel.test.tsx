// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import {
  ADMIN_PERMISSIONS,
  permissionsFor,
  resetPermissions,
  setNarrowedPermissions,
  setPermissions,
} from '@/test/permissions';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { TeamSettingsPanel } from './TeamSettingsPanel';

// The allowlist and agent-library sections have their own tests and fetch their own data.
vi.mock('@/components/teams/ShellAllowlistEditor', () => ({ ShellAllowlistEditor: () => null }));
vi.mock('@/components/teams/EgressAllowlistEditor', () => ({ EgressAllowlistEditor: () => null }));
vi.mock('@/components/teams/EventEndpointsCard', () => ({ EventEndpointsCard: () => null }));
vi.mock('@/components/teams/TeamAgentLibrarySection', () => ({
  TeamAgentLibrarySection: () => null,
}));
vi.mock('@/components/teams/TeamSecretsPanel', () => ({
  TeamSecretsPanel: () => <div data-testid="team-secrets-panel" />,
}));

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);

const TEAM_ID = '11111111-1111-4111-8111-111111111111';

// What the server says each kind of person holds on this team (`GET /me/permissions`).
const LEAD_CAPABILITIES = [
  'team.members.manage',
  'team.settings.manage',
  'team.persona.manage',
  'team.repos.manage',
  'team.repos.create',
  'team.knowledge-bases.manage',
  'team.callbacks.manage',
] as const;
const ADMIN_CAPABILITIES = [
  ...LEAD_CAPABILITIES,
  'team.budget.manage',
  'team.secrets.manage',
  'team.agents.manage',
  'team.plugins.manage',
] as const;
const standing = (role: string, capabilities: readonly (typeof ADMIN_CAPABILITIES)[number][]) =>
  permissionsFor({
    teams: [{ capabilities: [...capabilities], orgId: 'o', role, teamId: TEAM_ID }],
  });
const TEAM_LEAD = standing('LEAD', LEAD_CAPABILITIES);
const TEAM_ADMIN = standing('ADMIN', ADMIN_CAPABILITIES);
const TEAM_MEMBER = standing('MEMBER', []);
/** An organization admin with no membership: only the per-team answer says what they hold. */
const ORG_ADMIN = permissionsFor({
  orgs: [{ capabilities: ['org.budget.manage'], orgId: 'o', role: 'ADMIN' }],
});
const ORG_ADMIN_ON_TEAM = permissionsFor({
  teams: [
    {
      authority: 'org-admin',
      capabilities: [
        'team.members.manage',
        'team.settings.manage',
        'team.repos.manage',
        'team.repos.create',
        'team.budget.manage',
        'team.knowledge-bases.manage',
      ],
      orgId: 'o',
      role: null,
      teamId: TEAM_ID,
    },
  ],
});

const summary = (myRole: 'ADMIN' | 'LEAD' | 'MEMBER' | null) => ({
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
  setPermissions(ADMIN_PERMISSIONS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetPermissions();
});

function renderPanel(
  perms: Parameters<typeof setPermissions>[0] = TEAM_LEAD,
  myRole: 'ADMIN' | 'LEAD' | 'MEMBER' | null = null
) {
  setPermissions(perms);
  render(withQuery(<TeamSettingsPanel team={summary(myRole)} />));
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
    renderPanel(ADMIN_PERMISSIONS);
    await screen.findByLabelText('Persona');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Sandbox policy' }));
    expect(nav.replace.at(-1)).toBe('/teams/payments/settings?tab=sandbox');
    expect(screen.queryByLabelText('Persona')).toBeNull();
  });

  it('sends an old service-principals bookmark to the Manage tab', async () => {
    mockTeam();
    resetNavigation('tab=service-principals', '/teams/payments/settings');
    renderPanel();
    await waitFor(() => expect(nav.replace.at(-1)).toBe('/teams/payments/manage'));
  });

  it('offers a team lead no sandbox section, and lists no service principals', async () => {
    mockTeam();
    renderPanel(TEAM_LEAD, 'LEAD');
    await screen.findByRole('tab', { name: 'General' });
    // Allowlists need `team.sandbox-policy.manage`, which only a platform admin holds.
    expect(screen.queryByRole('tab', { name: 'Sandbox policy' })).toBeNull();
    // Service principals moved to the Manage tab.
    expect(screen.queryByRole('tab', { name: 'Service principals' })).toBeNull();
  });

  it('offers no persona section to a plain team member', async () => {
    mockTeam();
    renderPanel(TEAM_MEMBER, 'MEMBER');
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

  it('offers the Budget tab to a team admin who is not a platform admin', async () => {
    mock();
    renderPanel(TEAM_ADMIN, 'ADMIN');
    expect(await screen.findByRole('tab', { name: 'Budget' })).toBeTruthy();
  });

  it('hides the Budget tab from a team lead', async () => {
    mock();
    renderPanel(TEAM_LEAD, 'LEAD');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'Budget' })).toBeNull();
  });

  it('offers an organization admin who is not on the team the Budget tab, from the per-team answer', async () => {
    setNarrowedPermissions(TEAM_ID, ORG_ADMIN_ON_TEAM);
    mock();
    renderPanel(ORG_ADMIN);
    expect(await screen.findByRole('tab', { name: 'Budget' })).toBeTruthy();
    // Operation and sensitive sections are not an organization admin's.
    expect(screen.queryByRole('tab', { name: 'Secrets' })).toBeNull();
    expect(screen.queryByLabelText('Persona')).toBeNull();
  });

  it('shows an organization admin the sections they hold, not the team admin sections', async () => {
    setNarrowedPermissions(TEAM_ID, ORG_ADMIN_ON_TEAM);
    mock();
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(ORG_ADMIN);
    expect(await screen.findByTestId('team-budget-section')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'General' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Sandbox policy' })).toBeNull();
  });

  it('does not grant the tab when the server describes nothing for the person on this team', async () => {
    mock();
    renderPanel(ORG_ADMIN);
    await screen.findByRole('tab', { name: 'General' });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('tab', { name: 'Budget' })).toBeNull();
  });

  it('shows the Budget section with the Model configuration link to a platform admin', async () => {
    mock();
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(ADMIN_PERMISSIONS);
    expect(await screen.findByTestId('team-budget-section')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Model configuration' })).toBeTruthy();
  });

  it('omits the Model configuration link for a team admin who cannot reach the page', async () => {
    mock();
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(TEAM_ADMIN, 'ADMIN');
    await screen.findByTestId('team-budget-section');
    expect(screen.queryByRole('link', { name: 'Model configuration' })).toBeNull();
  });

  it('lists the pending budget requests above the editor for a caller who may edit the cap', async () => {
    mock({
      [`GET /api/v1/teams/${TEAM_ID}/budget-requests`]: () => ({
        data: [
          {
            createdAt: '2026-11-15T10:00:00.000Z',
            id: 'b1',
            reason: 'Launch month needs more headroom',
            requestedBy: { id: 'u1', name: 'Dana Lead' },
          },
        ],
      }),
    });
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(TEAM_ADMIN, 'ADMIN');
    const requests = await screen.findByTestId('budget-requests');
    expect(within(requests).getByText('Launch month needs more headroom')).toBeTruthy();
    expect(within(requests).getByText(/Dana Lead/)).toBeTruthy();
    const section = await screen.findByTestId('team-budget-section');
    expect(
      requests.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('dismisses a pending request and refetches the list', async () => {
    let pending = [
      {
        createdAt: '2026-11-15T10:00:00.000Z',
        id: 'b1',
        reason: 'Launch month needs more headroom',
        requestedBy: { id: 'u1', name: 'Dana Lead' },
      },
    ];
    const spy = mock({
      [`GET /api/v1/teams/${TEAM_ID}/budget-requests`]: () => ({ data: pending }),
      [`POST /api/v1/teams/${TEAM_ID}/budget-requests/b1/dismiss`]: () => {
        pending = [];
        return { data: { id: 'b1' } };
      },
    });
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(TEAM_ADMIN, 'ADMIN');
    const requests = await screen.findByTestId('budget-requests');
    fireEvent.click(
      within(requests).getByRole('button', {
        name: 'Dismiss request: Launch month needs more headro',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('budget-requests')).toBeNull());
    expect(
      spy.mock.calls.filter(([url]) => String(url).endsWith('/budget-requests')).length
    ).toBeGreaterThanOrEqual(2);
  });

  it('shows the error and keeps the request when the dismissal fails', async () => {
    const spy = mock({
      [`GET /api/v1/teams/${TEAM_ID}/budget-requests`]: () => ({
        data: [
          {
            createdAt: '2026-11-15T10:00:00.000Z',
            id: 'b1',
            reason: 'More',
            requestedBy: { id: 'u1', name: 'Dana Lead' },
          },
        ],
      }),
    });
    const base = spy.getMockImplementation() as (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => Promise<Response>;
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/dismiss')
        ? new Response(JSON.stringify({ error: { message: 'No pending budget request' } }), {
            headers: { 'content-type': 'application/json' },
            status: 404,
          })
        : base(input, init)
    );
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(TEAM_ADMIN, 'ADMIN');
    const requests = await screen.findByTestId('budget-requests');
    fireEvent.click(within(requests).getByRole('button', { name: 'Dismiss request: More' }));
    expect(await within(requests).findByText('No pending budget request')).toBeTruthy();
    expect(within(requests).getByText('More')).toBeTruthy();
  });

  it('renders nothing for the budget requests when there are none', async () => {
    mock({ [`GET /api/v1/teams/${TEAM_ID}/budget-requests`]: () => ({ data: [] }) });
    resetNavigation('tab=budget', '/teams/payments/settings');
    renderPanel(TEAM_ADMIN, 'ADMIN');
    await screen.findByTestId('team-budget-section');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('budget-requests')).toBeNull();
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
    renderPanel(TEAM_LEAD, 'LEAD');
    const card = await screen.findByTestId('shared-out');
    expect(
      within(card)
        .getByRole('switch', { name: 'Can launch work: Platform' })
        .getAttribute('aria-checked')
    ).toBe('false');
    expect(within(card).getByRole('button', { name: 'Revoke access for Platform' })).toBeTruthy();
  });

  it('shows no share management to a team member below lead', async () => {
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
    renderPanel(TEAM_MEMBER, 'MEMBER');
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
    renderPanel(TEAM_LEAD, 'LEAD');
    const chip = await screen.findByText('View only');
    expect(chip.closest('li')?.textContent).toContain('acme/ui');
    expect(chip.closest('li')?.textContent).toContain('from Design');
  });
});

describe('TeamSettingsPanel secrets', () => {
  beforeEach(() => {
    setupFetchMock({ [`GET /api/v1/teams/${TEAM_ID}`]: () => team('Be terse.') });
  });

  it('offers the Secrets tab to a team admin and shows the panel there', async () => {
    renderPanel(TEAM_ADMIN, 'ADMIN');
    await screen.findByRole('tab', { name: 'Secrets' });
    fireEvent.click(screen.getByRole('tab', { name: 'Secrets' }));
    expect(screen.getByTestId('team-secrets-panel')).toBeTruthy();
  });

  it('hides the Secrets tab from a team lead', async () => {
    renderPanel(TEAM_LEAD, 'LEAD');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'Secrets' })).toBeNull();
  });

  it('hides the Secrets tab from a team member who is not a platform admin', async () => {
    renderPanel(TEAM_MEMBER, 'MEMBER');
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'Secrets' })).toBeNull();
  });

  it('offers the Secrets tab to a platform admin whatever their team role', async () => {
    renderPanel(ADMIN_PERMISSIONS, 'MEMBER');
    await screen.findByRole('tab', { name: 'Secrets' });
  });
});
