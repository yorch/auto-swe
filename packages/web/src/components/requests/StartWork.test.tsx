// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';

// `role` is the platform role of the signed-in person (empty: nobody is signed in). What they may
// do comes from the server's answer, which `gateway()` derives from `role` and the team list.
const auth = vi.hoisted(() => ({ role: 'USER' }));
vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: { role: string; sub: string } | null }) => unknown) =>
    selector({ user: auth.role ? { role: auth.role, sub: 'me' } : null }),
}));
vi.mock('@/components/requests/WorkflowLaunchForm', () => ({
  WorkflowLaunchForm: ({
    template,
    showProcessSummary,
  }: {
    template: { id: string };
    showProcessSummary: boolean;
  }) => (
    <div data-summary={String(showProcessSummary)} data-testid={`form-${template.id}`}>
      Launch form
    </div>
  ),
}));
vi.mock('@/components/agentRuns/AgentRunForm', () => ({
  AgentRunForm: () => <div>agent form</div>,
}));

vi.mock('@/components/orchestrations/OrchestrateForm', () => ({
  OrchestrateForm: () => <div>orchestrate form</div>,
}));

import { modeChoices } from './ModeChooser';
import { StartWork } from './StartWork';

const team = (slug: string, name: string, myRole: 'ADMIN' | 'LEAD' | 'MEMBER') => ({
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

/**
 * What the server says the caller holds: a platform admin holds every capability; anyone else
 * holds `team.launch.multi-repo` on the teams where their team role is a lead's or above.
 */
function permissionsFor(teams: ReturnType<typeof team>[]) {
  return {
    organizations: [],
    platformCapabilities: auth.role === 'ADMIN' ? ['platform.users.manage'] : [],
    platformRole: '',
    teams: teams
      .filter((t) => t.myRole !== 'MEMBER')
      .map((t) => ({
        capabilities: [{ authority: 'team-role', key: 'team.launch.multi-repo' }],
        name: t.name,
        orgId: t.orgId,
        role: t.myRole,
        slug: t.slug,
        teamId: t.id,
      })),
  };
}

/** The caller leads Payments by default, so a lead can start an epic. */
function gateway(
  options: { teams?: ReturnType<typeof team>[]; repos?: ReturnType<typeof repo>[] } = {}
) {
  return setupFetchMock({
    'GET /api/v1/epics': () => ({ data: [], meta: { limit: 50, offset: 0, total: 0 } }),
    'GET /api/v1/me/permissions': () =>
      permissionsFor(options.teams ?? [team('payments', 'Payments', 'LEAD')]),
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
  const workflow = (name: string, extra: Record<string, unknown> = {}) => ({
    activeVersion: 1,
    description: 'A description that is not searchable',
    id: name,
    isDefault: false,
    lastRun: null,
    name,
    status: 'ACTIVE',
    team: null,
    ...extra,
  });
  const summarySpec = {
    entry: 'approve',
    name: 'Example',
    nodes: {
      approve: {
        group: 'Check the change',
        onApprove: 'done',
        onReject: 'done',
        onTimeout: 'done',
        timeout: '24h',
        title: 'Approve the change',
        type: 'humanApproval',
      },
      done: {
        result: { pullRequestUrl: { literal: 'url' } },
        status: 'SUCCESS',
        type: 'terminate',
      },
    },
    schemaVersion: 1,
  };
  function workflowsGateway(templates: ReturnType<typeof workflow>[], spec: unknown = summarySpec) {
    return setupFetchMock({
      'GET /api/v1/me/permissions': () => permissionsFor([team('payments', 'Payments', 'LEAD')]),
      'GET /api/v1/teams': () => ({ data: [team('payments', 'Payments', 'LEAD')] }),
      'GET /api/v1/workflow-templates': () => ({ data: templates }),
      ...Object.fromEntries(
        templates.map((template) => [
          `GET /api/v1/workflow-templates/${template.id}`,
          () => ({ data: { ...template, activeVersionSpec: { spec } } }),
        ])
      ),
    });
  }

  it('shows recent workflows first, catalog order next, and descriptive badges without duplicates', async () => {
    workflowsGateway([
      workflow('docs-refresh'),
      workflow('hotfix', { isDefault: true }),
      workflow('custom', {
        lastRun: { startedAt: '2026-11-01T00:00:00Z' },
        team: ref('payments', 'Payments'),
      }),
    ]);
    render(withQuery(<StartWork />));
    const input = await screen.findByRole('combobox', { name: 'Workflow' });
    await waitFor(() => expect(input).toHaveProperty('value', 'Production hotfix'));
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(within(screen.getByRole('listbox')).getAllByRole('group')).toHaveLength(2);
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('custom'),
      expect.stringContaining('Production hotfix'),
      expect.stringContaining('Documentation refresh'),
    ]);
    expect(
      within(screen.getByRole('option', { name: /custom/ })).getByText('Payments')
    ).toBeTruthy();
    const hotfix = within(screen.getByRole('option', { name: /Production hotfix/ }));
    expect(hotfix.getByText('Default')).toBeTruthy();
    expect(hotfix.getByText('A description that is not searchable')).toBeTruthy();
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'docs-refresh' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Documentation refresh/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: 'not searchable' } });
    expect(screen.queryByRole('option', { name: /Production hotfix/ })).toBeNull();
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('uses a non-git workflow rail without promising a pull request or merge', async () => {
    workflowsGateway(
      [workflow('zendesk-ticket-reply', { isDefault: true, workspaceProvider: 'api_only' })],
      {
        entry: 'done',
        name: 'Reply',
        nodes: {
          done: { result: { ticketUrl: { literal: 'url' } }, status: 'SUCCESS', type: 'terminate' },
        },
        schemaVersion: 1,
      }
    );
    render(withQuery(<StartWork />));
    expect(await screen.findByText('Ticket URL')).toBeTruthy();
    const rail = screen.getByLabelText('What happens next').textContent ?? '';
    expect(rail).toContain('record or document');
    expect(rail).not.toMatch(/pull request/i);
    expect(rail).not.toContain('Human steps:');
  });

  it.each([
    ['', '', 'Production hotfix'],
    ['payments', '', 'Custom team flow'],
    ['payments', 'hotfix', 'Production hotfix'],
  ])('preselects for team %s and link %s', async (initialTeamSlug, initialTemplateId, expected) => {
    workflowsGateway([
      workflow('hotfix', { isDefault: true }),
      workflow('Custom team flow', { isDefault: true, team: ref('payments', 'Payments') }),
      workflow('Foreign default', { isDefault: true, team: ref('foreign', 'Foreign') }),
    ]);
    render(
      withQuery(
        <StartWork initialTeamSlug={initialTeamSlug} initialTemplateId={initialTemplateId} />
      )
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Workflow' })).toHaveProperty('value', expected)
    );
    expect(
      await screen.findByTestId(`form-${expected === 'Production hotfix' ? 'hotfix' : expected}`)
    ).toBeTruthy();
  });

  it('falls back to a global default when a scoped team has none', async () => {
    workflowsGateway([workflow('hotfix', { isDefault: true })]);
    render(withQuery(<StartWork initialTeamSlug="payments" />));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Workflow' })).toHaveProperty(
        'value',
        'Production hotfix'
      )
    );
  });

  it('leaves the picker empty without an applicable default and honors an invalid deep link', async () => {
    workflowsGateway([workflow('hotfix', { isDefault: true })]);
    render(withQuery(<StartWork initialTemplateId="missing" />));
    expect(await screen.findByText(/not available to run/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Workflow' })).toHaveProperty('value', '');
    expect(screen.queryByTestId('form-hotfix')).toBeNull();
  });

  it('shows phases, human steps and outputs before the form as soon as a workflow is selected', async () => {
    workflowsGateway([workflow('hotfix')]);
    render(withQuery(<StartWork />));
    const input = await screen.findByRole('combobox', { name: 'Workflow' });
    expect(input).toHaveProperty('value', '');
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'hotfix' } });
    fireEvent.click(await screen.findByRole('option', { name: /Production hotfix/ }));
    const phase = await screen.findByText('Check the change');
    expect(screen.getByText('Approve the change')).toBeTruthy();
    expect(screen.getByText('Pull request URL')).toBeTruthy();
    const rail = screen.getByLabelText('What happens next').textContent ?? '';
    expect(rail).toContain('Approve the change');
    expect(rail).toContain('opens a pull request');
    expect(rail).toContain('No built-in step or template merges');
    const form = screen.getByTestId('form-hotfix');
    expect(phase.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.getAttribute('data-summary')).toBe('false');
  });

  it('keeps the form available when a process summary cannot be parsed', async () => {
    workflowsGateway([workflow('hotfix', { isDefault: true })], null);
    render(withQuery(<StartWork />));
    expect(await screen.findByText(/The process summary is unavailable/)).toBeTruthy();
    expect(screen.getByTestId('form-hotfix')).toBeTruthy();
  });

  it('humanizes external event names without exposing their Signal suffixes', async () => {
    workflowsGateway([workflow('hotfix', { isDefault: true })], {
      ...summarySpec,
      nodes: {
        ...summarySpec.nodes,
        ci: {
          name: 'ciPipelineSignal',
          onReceive: 'merge',
          onTimeout: 'done',
          timeout: '1h',
          type: 'signal',
        },
        merge: {
          name: 'humanMergeSignal',
          onReceive: 'done',
          onTimeout: 'done',
          timeout: '1h',
          type: 'signal',
        },
      },
    });
    render(withQuery(<StartWork />));
    expect(await screen.findByText('CI pipeline, Human merge')).toBeTruthy();
    expect(screen.queryByText('ciPipelineSignal, humanMergeSignal')).toBeNull();
    expect(screen.getByText('Waits for external events')).toBeTruthy();
  });

  it('offers only hand-launchable templates and explains blocked deep links', async () => {
    const templates = [
      { id: 'hotfix', kind: null, name: 'hotfix' },
      { id: 'review', kind: 'review', name: 'code-review' },
      { id: 'review-qodo', kind: 'review', name: 'code-review-qodo' },
      { id: 'human-review', kind: 'review', name: 'human-review-of-run' },
      { id: 'ci', kind: 'automation', name: 'ci-triage-and-fix' },
      { id: 'pr', kind: 'automation', name: 'address-pr-feedback' },
      { id: 'task', kind: 'automation', name: 'Channel Task' },
      { id: 'assistant', kind: null, name: 'Channel Assistant' },
    ].map((t) => ({ ...t, activeVersion: 1, status: 'ACTIVE', team: null }));
    setupFetchMock({
      'GET /api/v1/teams': () => ({ data: [] }),
      'GET /api/v1/workflow-templates': () => ({ data: templates }),
    });
    render(withQuery(<StartWork initialTemplateId="ci" />));
    expect(await screen.findByText(/Started by an automation or integration/)).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: /Workflow/ });
    act(() => picker.focus());
    fireEvent.change(picker, { target: { value: 'hot' } });
    expect(await screen.findByRole('option', { name: /Production hotfix/ })).toBeTruthy();
    fireEvent.change(picker, { target: { value: '' } });
    for (const template of templates.slice(1)) {
      expect(screen.queryByRole('option', { name: template.name })).toBeNull();
    }
  });
  it('disables the epic option below lead and says why', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    const radio = screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    // The epic and PRD options share the one reason.
    expect(screen.getAllByText('Requires team lead or administrator.')).toHaveLength(2);
  });

  it('offers a PRD run on the same gating as an epic', async () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    expect(
      (screen.getByRole('radio', { name: /run from a prd/i }) as HTMLInputElement).disabled
    ).toBe(true);
    cleanup();
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork initialMode="prd" />));
    await waitFor(() =>
      expect(
        (screen.getByRole('radio', { name: /run from a prd/i }) as HTMLInputElement).disabled
      ).toBe(false)
    );
    expect(
      (screen.getByRole('radio', { name: /run from a prd/i }) as HTMLInputElement).checked
    ).toBe(true);
  });

  it('starts in the requested mode', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork initialMode="agent" />));
    expect((screen.getByRole('radio', { name: /run an agent/i }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it('warns when the requested workflow cannot be run', async () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork initialTemplateId="missing" />));
    expect(await screen.findByText(/not available to run/i)).toBeTruthy();
  });

  it('shows the what-happens-next aside at every breakpoint', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    const aside = screen.getByLabelText('What happens next');
    expect(aside.className).not.toContain('hidden');
    expect(aside.classList.contains('xl:sticky')).toBe(true);
    expect(aside.classList.contains('xl:self-start')).toBe(true);
    expect(screen.getByText('Running a workflow')).toBeTruthy();
  });

  it('helps choose between a workflow, an agent and an epic', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    expect(screen.getByText('Need help choosing?').parentElement?.getAttribute('open')).toBeNull();
    expect(screen.getByText(/Not sure\?/)).toBeTruthy();
    expect(screen.getByText('How auto-swe works')).toBeTruthy();
  });

  it('lets a lead pick each mode from the chooser with one click', async () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    await epicEnabled();
    fireEvent.click(screen.getByText('Need help choosing?'));
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

  it('never offers or recommends an epic to someone who leads no team, and says why', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    fireEvent.click(screen.getByText('Need help choosing?'));
    const chooser = within(screen.getByTestId('mode-hint'));
    expect(chooser.queryByRole('button', { name: /epic/i })).toBeNull();
    expect(chooser.getByText(/Only team leads and administrators can start an epic/)).toBeTruthy();
    expect(chooser.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Pick a workflow',
      'Run an agent',
      'Orchestrate agents',
      'Describe the goal',
    ]);
  });

  it('offers orchestration to a signed-in person and shows its form', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork initialMode="orchestrate" />));
    const option = screen.getByRole('radio', { name: /orchestrate agents/i }) as HTMLInputElement;
    expect(option.disabled).toBe(false);
    expect(option.checked).toBe(true);
    expect(screen.getByText('orchestrate form')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /orchestrating agents/i })).toBeTruthy();
  });

  it('does not mount the orchestration form until its mode is chosen, then keeps it', () => {
    auth.role = 'USER';
    gateway();
    render(withQuery(<StartWork />));
    expect(screen.queryByText('orchestrate form')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /orchestrate agents/i }));
    expect(screen.getByText('orchestrate form')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /run an agent/i }));
    // Switching away hides it; the half-filled form is not thrown away.
    expect(screen.getByText('orchestrate form').closest('[hidden]')).not.toBeNull();
  });

  it('neither offers nor starts in orchestration without a session', () => {
    auth.role = '';
    gateway();
    render(withQuery(<StartWork initialMode="orchestrate" />));
    const option = screen.getByRole('radio', { name: /orchestrate agents/i }) as HTMLInputElement;
    expect(option.disabled).toBe(true);
    expect(option.checked).toBe(false);
    expect(screen.queryByText('orchestrate form')).toBeNull();
    expect(screen.queryByRole('heading', { name: /orchestrating agents/i })).toBeNull();
    fireEvent.click(screen.getByText('Need help choosing?'));
    const chooser = within(screen.getByTestId('mode-hint'));
    expect(chooser.queryByRole('button', { name: /orchestrate/i })).toBeNull();
    expect(chooser.getByText(/Requires a signed-in account/)).toBeTruthy();
  });

  it('offers the describe-the-goal mode without fetching plans until it is chosen', async () => {
    auth.role = 'USER';
    const spy = gateway();
    render(withQuery(<StartWork />));
    expect(screen.getByRole('radio', { name: /describe the goal/i })).toBeTruthy();
    expect(spy.mock.calls.some(([u]) => String(u).includes('/run-plans'))).toBe(false);
  });

  it('describes the chooser rows from the mode table', () => {
    expect(modeChoices(true).every((c) => c.action)).toBe(true);
    expect(modeChoices(false).find((c) => c.mode === 'epic')?.action).toBeUndefined();
    expect(
      modeChoices(true, undefined, false).find((c) => c.mode === 'orchestrate')?.action
    ).toBeUndefined();
  });

  it('never promises a draft pull request or a per-repository request in the side rail', async () => {
    auth.role = 'USER';
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
    it('hides the epic from someone who leads no team, and says so', async () => {
      auth.role = 'USER';
      gateway({ teams: [team('payments', 'Payments', 'MEMBER')] });
      render(withQuery(<StartWork />));
      expect((await screen.findAllByText(/You do not lead a team/)).length).toBeGreaterThan(0);
      const radio = screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement;
      expect(radio.disabled).toBe(true);
      const chooser = within(screen.getByTestId('mode-hint'));
      expect(chooser.queryByRole('button', { name: /epic/i })).toBeNull();
    });

    it('names the scope team when the caller leads another team but not that one', async () => {
      auth.role = 'USER';
      gateway({
        teams: [team('payments', 'Payments', 'MEMBER'), team('data', 'Data', 'LEAD')],
      });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      expect((await screen.findAllByText(/Requires lead of Payments/)).length).toBeGreaterThan(0);
      expect(
        (screen.getByRole('radio', { name: /multi-repo epic/i }) as HTMLInputElement).disabled
      ).toBe(true);
    });

    it('offers the epic when the caller leads the scope team', async () => {
      auth.role = 'USER';
      gateway({ teams: [team('payments', 'Payments', 'LEAD')] });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      await epicEnabled();
    });

    it('offers a platform admin the epic without any team role', async () => {
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
      auth.role = 'USER';
      gateway({
        repos,
        teams: [
          team('payments', 'Payments', 'LEAD'),
          team('platform', 'Platform', 'LEAD'),
          team('data', 'Data', 'MEMBER'),
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
      auth.role = 'USER';
      gateway({ repos, teams: [team('payments', 'Payments', 'MEMBER')] });
      render(withQuery(<StartWork initialTeamSlug="payments" />));
      expect((await screen.findByTestId('start-scope')).textContent).toContain('Payments');
    });

    it('ignores a team slug the caller is not a member of', async () => {
      auth.role = 'USER';
      gateway({ repos, teams: [team('payments', 'Payments', 'MEMBER')] });
      render(withQuery(<StartWork initialTeamSlug="secret" />));
      await waitFor(() => expect(screen.getByText('Running a workflow')).toBeTruthy());
      expect(screen.queryByTestId('start-scope')).toBeNull();
    });
  });
});
