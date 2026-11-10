// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

const auth = vi.hoisted(() => ({ role: 'ENGINEER' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string } | null }) => unknown) =>
    selector({ user: { role: auth.role } }),
}));
vi.mock('@/components/requests/WorkflowLaunchForm', () => ({ WorkflowLaunchForm: () => null }));
vi.mock('@/components/agentRuns/AgentRunForm', () => ({
  AgentRunForm: () => <div>agent form</div>,
}));

import { modeChoices } from './ModeChooser';
import { StartWork } from './StartWork';

const team = (slug: string, name: string, myRole: 'ADMIN' | 'LEAD' | 'ENGINEER') => ({
  id: `id-${slug}`,
  myRole,
  name,
  orgId: 'o',
  orgName: 'Acme',
  slug,
});
const ref = (slug: string, name: string) => ({ id: `id-${slug}`, name, slug });
const repo = (
  name: string,
  owner: ReturnType<typeof ref>,
  sharedWith: ReturnType<typeof ref>[] = []
) => ({
  defaultBranch: 'main',
  id: `repo-${name}`,
  organizationName: 'acme',
  repoName: name,
  shares: sharedWith.map((t) => ({ team: t })),
  team: owner,
  type: 'git_repo',
});

/** The caller leads Payments by default, so a LEAD can start an epic. */
function gateway(
  options: { teams?: ReturnType<typeof team>[]; repos?: ReturnType<typeof repo>[] } = {}
) {
  return setupFetchMock({
    'GET /api/v1/epics': () => ({ data: [], meta: { limit: 50, offset: 0, total: 0 } }),
    'GET /api/v1/repositories': () => ({ data: options.repos ?? [] }),
    'GET /api/v1/teams': () => ({ data: options.teams ?? [team('payments', 'Payments', 'LEAD')] }),
    'GET /api/v1/workflow-templates': () => ({ data: [] }),
  });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The epic option is judged by the caller's team role, which loads with the team list. */
async function epicEnabled() {
  await waitFor(() =>
    expect(
      (screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement).disabled
    ).toBe(false)
  );
}

describe('StartWork', () => {
  it('disables the epic option below lead and says why', () => {
    auth.role = 'ENGINEER';
    gateway();
    render(withQuery(<StartWork />));
    const radio = screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(screen.getByText('Requires team lead or administrator.')).toBeTruthy();
  });

  it('starts in the requested mode', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork initialMode="agent" />));
    expect((screen.getByRole('radio', { name: /run an agent/i }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it('warns when the requested workflow cannot be run', async () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork initialTemplateId="missing" />));
    expect(await screen.findByText(/not available to run/i)).toBeTruthy();
  });

  it('shows the what-happens-next aside at every breakpoint', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    const aside = screen.getByLabelText('What happens next');
    expect(aside.className).not.toContain('hidden');
    expect(screen.getByText('Running a workflow')).toBeTruthy();
  });

  it('helps choose between a workflow, an agent and an epic', () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    expect(screen.getByText(/Not sure\?/)).toBeTruthy();
    expect(screen.getByText('How auto-swe works')).toBeTruthy();
  });

  it('lets a lead pick each mode from the chooser with one click', async () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    await epicEnabled();
    const chooser = within(screen.getByTestId('mode-hint'));
    const checked = (name: RegExp) =>
      (screen.getByRole('radio', { name }) as HTMLInputElement).checked;
    fireEvent.click(chooser.getByRole('button', { name: 'Run an agent' }));
    expect(checked(/run an agent/i)).toBe(true);
    // The chooser's pressed state follows the same mode as the radio group.
    expect(chooser.getByRole('button', { name: 'Run an agent' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(
      chooser.getByRole('button', { name: 'Pick a workflow' }).getAttribute('aria-pressed')
    ).toBe('false');
    fireEvent.click(screen.getByRole('radio', { name: /run a workflow/i }));
    expect(
      chooser.getByRole('button', { name: 'Pick a workflow' }).getAttribute('aria-pressed')
    ).toBe('true');
    fireEvent.click(chooser.getByRole('button', { name: 'Run an agent' }));
    fireEvent.click(chooser.getByRole('button', { name: 'Run an epic' }));
    expect(checked(/multi-repo epic/i)).toBe(true);
    fireEvent.click(chooser.getByRole('button', { name: 'Pick a workflow' }));
    expect(checked(/run a workflow/i)).toBe(true);
  });

  it('never offers or recommends an epic to an engineer, and says why', () => {
    auth.role = 'ENGINEER';
    gateway();
    render(withQuery(<StartWork />));
    const chooser = within(screen.getByTestId('mode-hint'));
    expect(chooser.queryByRole('button', { name: /epic/i })).toBeNull();
    expect(chooser.getByText(/Only team leads and administrators can start an epic/)).toBeTruthy();
    expect(chooser.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Pick a workflow',
      'Run an agent',
    ]);
  });

  it('describes the chooser rows from the mode table', () => {
    expect(modeChoices(true).every((c) => c.action)).toBe(true);
    expect(modeChoices(false).find((c) => c.mode === 'epic')?.action).toBeUndefined();
  });

  it('never promises a draft pull request or a per-repository request in the side rail', async () => {
    auth.role = 'LEAD';
    gateway();
    render(withQuery(<StartWork />));
    await epicEnabled();
    for (const mode of [/Run a workflow/, /Run an agent/, /multi-repo epic/]) {
      fireEvent.click(screen.getByRole('radio', { name: mode }));
      const text = screen.getByLabelText('What happens next').textContent ?? '';
      // An agent run may deliver a draft pull request by choice; workflows and epics never promise one.
      if (!/Run an agent/.test(String(mode))) {
        expect(text).not.toMatch(/draft/i);
      }
    }
    fireEvent.click(screen.getByRole('radio', { name: /multi-repo epic/ }));
    const epic = screen.getByLabelText('What happens next').textContent ?? '';
    expect(epic).toMatch(/one run per repository/);
    expect(epic).not.toMatch(/draft/i);
  });

  describe('epic gating by team role', () => {
    it('hides the epic from a platform lead who leads no team, and says so', async () => {
      auth.role = 'LEAD';
      gateway({ teams: [team('payments', 'Payments', 'ENGINEER')] });
      render(withQuery(<StartWork />));
      expect((await screen.findAllByText(/You do not lead a team/)).length).toBeGreaterThan(0);
      const radio = screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement;
      expect(radio.disabled).toBe(true);
      const chooser = within(screen.getByTestId('mode-hint'));
      expect(chooser.queryByRole('button', { name: /epic/i })).toBeNull();
    });

    it('names the scope team when the caller leads another team but not that one', async () => {
      auth.role = 'LEAD';
      gateway({
        teams: [team('payments', 'Payments', 'ENGINEER'), team('data', 'Data', 'LEAD')],
      });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      expect((await screen.findAllByText(/Requires lead of Payments/)).length).toBeGreaterThan(0);
      expect(
        (screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement).disabled
      ).toBe(true);
    });

    it('offers the epic when the caller leads the scope team', async () => {
      auth.role = 'LEAD';
      gateway({ teams: [team('payments', 'Payments', 'LEAD')] });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      await epicEnabled();
    });

    it('offers a platform ADMIN the epic without any team role', async () => {
      auth.role = 'ADMIN';
      gateway({ teams: [] });
      render(withQuery(<StartWork />));
      await epicEnabled();
    });
  });

  describe('repository grouping and ownership', () => {
    const payments = ref('payments', 'Payments');
    const platform = ref('platform', 'Platform');
    const data = ref('data', 'Data');
    const repos = [
      repo('ledger', payments),
      repo('ui-kit', platform, [payments]),
      repo('warehouse', data),
    ];

    it('groups the epic’s repositories as “Payments”, then “Shared with Payments”, and keeps out repositories of teams the caller does not lead', async () => {
      auth.role = 'LEAD';
      gateway({
        repos,
        teams: [
          team('payments', 'Payments', 'LEAD'),
          team('platform', 'Platform', 'LEAD'),
          team('data', 'Data', 'ENGINEER'),
        ],
      });
      render(withQuery(<StartWork initialMode="epic" initialTeamSlug="payments" />));
      await epicEnabled();
      const fieldset = within(await screen.findByRole('group', { name: /Repositories/ }));
      const own = await fieldset.findByText('Payments');
      const shared = fieldset.getByText('Shared with Payments');
      expect(own.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(fieldset.getByText('acme/ledger')).toBeTruthy();
      expect(fieldset.getByText('acme/ui-kit')).toBeTruthy();
      // An epic may span only repositories owned by a team the caller leads: Data is not one.
      expect(fieldset.queryByText('acme/warehouse')).toBeNull();
      expect(screen.getByTestId('epic-hidden-repos').textContent).toContain('1 repository is');
    });

    it('says which team the work is for', async () => {
      auth.role = 'ENGINEER';
      gateway({ repos, teams: [team('payments', 'Payments', 'ENGINEER')] });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      expect((await screen.findByTestId('start-scope')).textContent).toContain('Payments');
    });

    it('ignores a team slug the caller is not a member of', async () => {
      auth.role = 'ENGINEER';
      gateway({ repos, teams: [team('payments', 'Payments', 'ENGINEER')] });
      render(withQuery(<StartWork initialTeamSlug="secret" />));
      await waitFor(() => expect(screen.getByText('Running a workflow')).toBeTruthy());
      expect(screen.queryByTestId('start-scope')).toBeNull();
    });
  });
});
