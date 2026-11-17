// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import AgentLibraryPage from './page';

const { createAgent, modalProps, state, updateAgent } = vi.hoisted(() => ({
  createAgent: vi.fn(),
  modalProps: { current: null as null | { agents: AgentRow[]; open: boolean } },
  state: {
    admin: true,
    agents: [] as AgentRow[],
    createPending: false,
    teams: [] as { id: string; name: string }[],
    updatePending: false,
  },
  updateAgent: vi.fn(),
}));

const row = (id: string, name: string, key: string): AgentRow => ({
  channelId: null,
  createdAt: '',
  credentialId: null,
  description: null,
  id,
  inheritsModelFrom: null,
  isActive: true,
  isBuiltIn: false,
  isVerified: true,
  key,
  mcpConnectionId: null,
  modelSpec: 'anthropic/claude-opus-5-5',
  name,
  orgId: null,
  origin: null,
  runtime: 'mastra',
  scope: 'GLOBAL',
  skillRefs: [],
  systemPrompt: null,
  teamId: null,
  toolKeys: null,
  version: 1,
  workflowTemplateId: null,
});

vi.mock('@/hooks/useAgentLibrary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgentLibrary')>()),
  useAgentLibrary: () => ({
    data: state.agents,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useCreateAgent: () => ({ isPending: state.createPending, mutateAsync: createAgent }),
  useDeleteAgent: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAgent: () => ({ isPending: state.updatePending, mutateAsync: updateAgent }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useAdmin', () => ({ useOrganizationDirectory: () => ({ data: [] }) }));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => state.admin }));
vi.mock('@/hooks/useMcpConnections', () => ({ useMcpConnections: () => ({ data: [] }) }));
vi.mock('@/hooks/useModelConfig', () => ({ useAdminCredentials: () => ({ data: [] }) }));
vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({ data: { items: [], providers: [] } }),
}));
vi.mock('@/hooks/useSkills', () => ({ useSkills: () => ({ data: [] }) }));
vi.mock('@/hooks/useSlackChannels', () => ({ useSlackChannels: () => ({ data: [] }) }));
vi.mock('@/hooks/useTeams', () => ({ useTeams: () => ({ data: state.teams }) }));
vi.mock('@/hooks/useTemplates', () => ({ useWorkflowTemplates: () => ({ data: [] }) }));
// The modal owns the model-change flow and is covered on its own; here it only reports what the
// page handed it.
vi.mock('@/components/agents/BulkModelModal', () => ({
  BulkModelModal: (props: { agents: AgentRow[]; open: boolean }) => {
    modalProps.current = props;
    return null;
  },
}));

beforeEach(() => {
  stubDialogPrototype();
  modalProps.current = null;
  state.admin = true;
  state.createPending = false;
  state.updatePending = false;
  state.teams = [];
  state.agents = [row('a1', 'Alpha', 'alpha'), row('b1', 'Beta', 'beta')];
  updateAgent.mockReset();
  createAgent.mockReset();
  createAgent.mockResolvedValue({ data: row('n1', 'Alpha', 'alpha') });
});

describe('agent library — activation', () => {
  it('keeps version and verification together with the origin available as a tooltip', () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), origin: 'swe-starter' }];
    render(withQuery(<AgentLibraryPage />));
    const version = screen.getByText('v1');
    const line = version.parentElement;
    expect(line?.classList.contains('flex-nowrap')).toBe(true);
    expect(line?.textContent).toContain('Verified');
    expect(line?.getAttribute('title')).toBe('Engineering starter');
    expect(screen.getByText('Origin: Engineering starter').classList.contains('sr-only')).toBe(
      true
    );
  });
  it('marks inactive rows and leaves active rows unmarked', () => {
    state.agents = [row('a1', 'Alpha', 'alpha'), { ...row('b1', 'Beta', 'beta'), isActive: false }];
    render(withQuery(<AgentLibraryPage />));

    expect(screen.getAllByText('Deactivated')).toHaveLength(1);
    // The mark distinguishes the two, rather than appearing on whatever is in the table.
    expect(screen.getAllByText('Deactivated')[0].closest('tr')?.textContent).toContain('Beta');
  });

  it('leaves active rows unmarked', () => {
    render(withQuery(<AgentLibraryPage />));

    expect(screen.queryByText('Deactivated')).toBeNull();
  });

  it('reactivates an inactive row through the update hook', async () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), isActive: false }];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for alpha' }));
    fireEvent.click(await screen.findByText('Reactivate'));
    expect(updateAgent).toHaveBeenCalledWith({ body: { isActive: true }, id: 'a1' });
  });

  it('says so when a reactivation fails', async () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), isActive: false }];
    updateAgent.mockRejectedValue(new Error('Agent changed since version 3 was read'));
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for alpha' }));
    fireEvent.click(await screen.findByText('Reactivate'));
    // Otherwise the row simply stays as it was and nothing says an attempt was made.
    expect(await screen.findByText('Agent changed since version 3 was read')).toBeTruthy();
  });

  it('offers Deactivate only for active rows', async () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), isActive: false }, row('b1', 'Beta', 'beta')];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for alpha' }));
    expect(screen.queryByRole('menuitem', { name: 'Deactivate' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for beta' }));
    expect(await screen.findByRole('menuitem', { name: 'Deactivate' })).toBeTruthy();
  });

  it('explains that an inactive row must be reactivated before editing', () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), isActive: false }];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    expect(screen.getByText('This agent is deactivated. Reactivate it to change it.')).toBeTruthy();
  });

  it('makes the edit form read-only while the agent is deactivated, and offers Reactivate', () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), isActive: false }];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    expect(screen.getByDisplayValue('Alpha').matches(':disabled')).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Save new version' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(updateAgent).toHaveBeenCalledWith({ body: { isActive: true }, id: 'a1' });
  });

  it('asks before discarding an edited agent', () => {
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Alpha 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Discard unsaved changes?' })).toBeTruthy();
  });

  it('closes an untouched edit form without asking', () => {
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Discard unsaved changes?' })).toBeNull();
  });
});

describe('agent library — bulk model change', () => {
  it('offers a selection column and hands the selected agents to the modal', () => {
    render(withQuery(<AgentLibraryPage />));

    expect(screen.getByRole('checkbox', { name: 'Select all visible agents' })).toBeTruthy();
    expect(screen.queryByText('1 selected')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alpha' }));
    expect(screen.getByText('1 selected')).toBeTruthy();

    // The modal is mounted closed until the operator asks for it.
    expect(modalProps.current?.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Change model' }));
    expect(modalProps.current?.open).toBe(true);
    expect(modalProps.current?.agents.map((a) => a.id)).toEqual(['a1']);
  });

  it('selects every visible row from the header checkbox and clears on demand', () => {
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible agents' }));
    expect(screen.getByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByText('2 selected')).toBeNull();
  });

  // Exercising this ceiling takes 201 visible rows — the whole table rendered,
  // then selected through the header checkbox. That is the work a loaded CI
  // runner ran out of the 5 s default on; the test costs ~1 s under coverage
  // here, so the budget is headroom rather than a fix for what it asserts.
  it('will not offer a change the gateway would refuse', () => {
    state.agents = Array.from({ length: 201 }, (_, index) =>
      row(`a${index}`, `Agent ${index}`, `agent-${index}`)
    );
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible agents' }));
    expect(screen.getByText(/At most 200 can be changed at once/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change model' }).hasAttribute('disabled')).toBe(
      true
    );
  }, 20_000);

  it('gives a non-admin no selection column and no way to change models in bulk', () => {
    state.admin = false;
    render(withQuery(<AgentLibraryPage />));

    expect(screen.queryByRole('checkbox', { name: 'Select all visible agents' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select alpha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
    expect(modalProps.current).toBeNull();
  });
});

describe('agent library — reactivate inside the edit form', () => {
  it('saves against the new version the reactivation cut', async () => {
    const inactive = { ...row('a1', 'Alpha', 'alpha'), isActive: false };
    state.agents = [inactive];
    updateAgent.mockResolvedValueOnce({
      data: { ...inactive, id: 'a2', isActive: true, version: 2 },
    });
    updateAgent.mockResolvedValueOnce({
      data: { ...inactive, id: 'a3', isActive: true, version: 3 },
    });
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await screen.findByText(/v2 → v3/);
    fireEvent.change(screen.getByDisplayValue('Alpha'), { target: { value: 'Alpha 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(2));
    expect(updateAgent.mock.calls[1][0]).toMatchObject({ id: 'a2' });
  });
});

describe('agent library — saving holds the forms open', () => {
  it('disables the close button of the edit form while a save is pending', () => {
    state.updatePending = true;
    render(withQuery(<AgentLibraryPage />));
    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('disables the close button of the create form while a create is pending', () => {
    state.createPending = true;
    render(withQuery(<AgentLibraryPage />));
    fireEvent.click(screen.getAllByRole('button', { name: /New agent/ })[0]);
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});

describe('agent library — create form', () => {
  it('starts every opening on its own model, not the previous inherit choice', () => {
    render(withQuery(<AgentLibraryPage />));
    fireEvent.click(screen.getAllByRole('button', { name: /New agent/ })[0]);
    fireEvent.click(screen.getByRole('radio', { name: /Inherit from another agent/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: /New agent/ })[0]);
    expect((screen.getByRole('radio', { name: /Own model/ }) as HTMLInputElement).checked).toBe(
      true
    );
  });

  it('names the scope target that is still missing', async () => {
    render(withQuery(<AgentLibraryPage />));
    fireEvent.click(screen.getAllByRole('button', { name: /New agent/ })[0]);
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Custom' } });
    fireEvent.click(screen.getByRole('button', { name: /Where it applies/ }));
    fireEvent.click(await screen.findByRole('option', { name: /^Team/ }));
    expect(screen.getByText('Pick the team this agent applies to.')).toBeTruthy();
    expect(
      screen.getByText(/No platform agent has this key — this creates a standalone agent\./)
    ).toBeTruthy();
  });

  it('offers an override of a platform agent with the key fixed and the form prefilled', async () => {
    state.teams = [{ id: 't1', name: 'Payments' }];
    state.agents = [
      {
        ...row('a1', 'Alpha', 'alpha'),
        credentialId: 'cred-1',
        harnessProfiles: ['strict-profile'],
        reasoning: 'high',
        runtime: 'claude-code',
        systemPrompt: 'Be careful',
      },
    ];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for alpha' }));
    fireEvent.click(await screen.findByText('Create override…'));
    // The platform scope is not offered: the key already belongs to a platform agent.
    fireEvent.click(screen.getByRole('button', { name: /Where it applies/ }));
    expect(screen.queryByRole('option', { name: /^Platform/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /^Team/ }));
    const key = screen.getByDisplayValue('alpha') as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    expect(screen.getByDisplayValue('Alpha')).toBeTruthy();
    expect(screen.getByDisplayValue('Be careful')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Where it applies/ }).textContent).toContain('Team');
    // A prefilled form is not an unsaved edit until it is changed.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Discard unsaved changes?' })).toBeNull();
  });

  it('copies the runtime, harness profile, reasoning and credential into an override', async () => {
    state.teams = [{ id: 't1', name: 'Payments' }];
    state.agents = [
      {
        ...row('a1', 'Alpha', 'alpha'),
        credentialId: 'cred-1',
        harnessProfiles: ['strict-profile'],
        reasoning: 'high',
        runtime: 'claude-code',
        systemPrompt: 'Be careful',
      },
    ];
    render(withQuery(<AgentLibraryPage />));

    fireEvent.click(screen.getByRole('button', { name: 'More actions for alpha' }));
    fireEvent.click(await screen.findByText('Create override…'));
    fireEvent.focus(screen.getByPlaceholderText('Select a team…'));
    fireEvent.keyDown(screen.getByPlaceholderText('Select a team…'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(createAgent).toHaveBeenCalled());
    expect(createAgent.mock.calls[0][0]).toMatchObject({
      credentialId: 'cred-1',
      harnessProfiles: ['strict-profile'],
      key: 'alpha',
      reasoning: 'high',
      runtime: 'claude-code',
      scope: 'TEAM',
      teamId: 't1',
    });
  });

  it('offers the override action on platform-wide rows only', async () => {
    state.agents = [
      row('a1', 'Alpha', 'alpha'),
      { ...row('a2', 'Alpha', 'alpha'), scope: 'TEAM', teamId: 't1' },
    ];
    render(withQuery(<AgentLibraryPage />));
    const buttons = screen.getAllByRole('button', { name: 'More actions for alpha' });
    fireEvent.click(buttons[1]);
    expect(screen.queryByRole('menuitem', { name: 'Create override…' })).toBeNull();
  });
});

describe('agent library — list', () => {
  it('marks overrides by scope, naming the platform agent only when one exists', () => {
    state.agents = [
      row('a1', 'Alpha', 'alpha'),
      { ...row('a2', 'Alpha team', 'alpha'), scope: 'TEAM', teamId: 't1' },
      { ...row('b1', 'Lonely', 'lonely'), scope: 'TEAM', teamId: 't1' },
    ];
    render(withQuery(<AgentLibraryPage />));
    expect(screen.getByText('Override of Alpha')).toBeTruthy();
    expect(screen.queryByText('Scoped override')).toBeNull();
    expect(screen.queryByText(/Override of Lonely/)).toBeNull();
  });

  it('searches the model too, and uses the navigation label and singular count', () => {
    state.agents = [{ ...row('a1', 'Alpha', 'alpha'), modelSpec: 'acme/zeta-9' }];
    const { unmount } = render(withQuery(<AgentLibraryPage />));
    expect(screen.getByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    expect(screen.getByText('1 agent')).toBeTruthy();
    unmount();

    state.agents = [
      { ...row('a1', 'Alpha', 'alpha'), modelSpec: 'acme/zeta-9' },
      { ...row('b1', 'Bravo', 'bravo'), modelSpec: 'acme/other-1' },
    ];
    render(withQuery(<AgentLibraryPage />));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), {
      target: { value: 'zeta-9' },
    });
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByText('Bravo')).toBeNull();
  });

  it('puts the scope in the edit form subtitle', () => {
    state.agents = [{ ...row('a2', 'Alpha team', 'alpha'), scope: 'TEAM', teamId: 't1' }];
    state.teams = [{ id: 't1', name: 'Payments' }];
    render(withQuery(<AgentLibraryPage />));
    fireEvent.click(screen.getByRole('button', { name: 'Edit alpha' }));
    expect(screen.getByText('alpha · Team: Payments · v1 → v2')).toBeTruthy();
  });
});
