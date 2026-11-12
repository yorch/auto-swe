// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authoring: { global: false, isLoading: false, teams: [] as { id: string; name: string }[] },
  member: [] as { id: string; name: string; slug: string }[],
  templates: [] as unknown[],
}));
const idle = { isError: false, isLoading: false, isPending: false, mutateAsync: vi.fn() };

const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/library',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock('@/hooks/useTeams', () => ({
  useAuthoringTeams: () => state.authoring,
  useLedTeamIds: () => new Set<string>(),
  useTeams: () => ({ data: state.member, isLoading: false }),
}));
vi.mock('@/hooks/useTemplates', () => ({
  useCreateWorkflowTemplate: () => idle,
  useStartWorkflowGenerationJob: () => idle,
  useUpdateWorkflowTemplate: () => idle,
  useWorkflowGenerationJob: () => ({ data: undefined }),
  useWorkflowTemplates: () => ({
    data: state.templates,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { useAuthStore } from '@/stores/authStore';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import TemplatesPage from './page';

stubDialogPrototype();

afterEach(() => {
  cleanup();
  nav.query = '';
  state.authoring = { global: false, isLoading: false, teams: [] };
  state.member = [];
  idle.mutateAsync.mockReset();
});

const base = {
  activeVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  description: '',
  experimentSplit: null,
  experimentVersion: null,
  id: 't-1',
  inputSchema: null,
  isDefault: false,
  lastRun: null,
  name: 'Ticket to PR',
  status: 'ACTIVE',
  team: { id: 'team-1', name: 'Payments', slug: 'payments' },
  updatedAt: '2026-01-02T00:00:00.000Z',
  versionCount: 1,
  webhookConfigured: false,
  webhookSigning: {
    configured: false,
    lastFour: null,
    previousExpiresAt: null,
    requireSignature: false,
  },
};

describe('Workflow library', () => {
  it('explains review and automation launch paths instead of offering Run', () => {
    state.templates = [
      { ...base, id: 'review', kind: 'review', name: 'code-review' },
      { ...base, id: 'automation', kind: 'automation', name: 'ci-triage-and-fix' },
    ];
    render(<TemplatesPage />);
    expect(screen.getByText('Review only').getAttribute('title')).toBe(
      "Started from a finished run's Reviews panel"
    );
    expect(screen.getByText('Automatic').getAttribute('title')).toBe(
      'Started by an automation or integration'
    );
    expect(screen.queryByRole('link', { name: 'Run code-review' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Run ci-triage-and-fix' })).toBeNull();
  });
  it('says why a system-managed workflow has no Run button', () => {
    state.templates = [base, { ...base, id: 't-2', name: 'Channel Assistant', team: null }];
    render(<TemplatesPage />);
    expect(screen.getByText('Automatic').getAttribute('title')).toBe(
      'Started automatically by the platform'
    );
    expect(screen.getByRole('link', { name: 'Run Ticket to PR' })).toBeTruthy();
  });
  it('uses a compact explanation for workflows without a promoted version and secondary description text', () => {
    state.templates = [{ ...base, activeVersion: null, description: 'Workflow description' }];
    render(<TemplatesPage />);
    expect(screen.getByText('Not ready').getAttribute('title')).toBe('Promote a version to run');
    expect(screen.queryByRole('link', { name: 'Run Ticket to PR' })).toBeNull();
    expect(screen.getByText('Workflow description').classList.contains('text-paper-400')).toBe(
      true
    );
  });

  it('explains active, draft and archived above the table, not in a header tip', () => {
    state.templates = [base];
    render(<TemplatesPage />);
    expect(
      screen.getByText(/Active templates can be launched once a version is promoted/)
    ).toBeTruthy();
    expect(screen.getByText(/Archived templates are hidden from the default list/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'About Status' })).toBeNull();
  });

  it('reads the status filter from the address', () => {
    state.templates = [base, { ...base, id: 't-3', name: 'Old flow', status: 'ARCHIVED' }];
    nav.query = 'status=archived';
    render(<TemplatesPage />);
    expect(screen.getByText('Old flow')).toBeTruthy();
    expect(screen.queryByText('Ticket to PR')).toBeNull();
  });

  it('counts each status within the current search', () => {
    state.templates = [
      base,
      { ...base, id: 't-4', name: 'Another', status: 'DRAFT' },
      { ...base, id: 't-5', name: 'Third', status: 'DRAFT' },
    ];
    nav.query = 'q=another';
    render(<TemplatesPage />);
    const drafts = screen.getByRole('button', { name: /Drafts/ });
    expect(drafts.textContent).toContain('1');
  });

  it('offers blank creation inside the one New workflow dialog', async () => {
    state.templates = [base];
    state.authoring = { global: true, isLoading: false, teams: [] };
    useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
    render(<TemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Blank' }));
    expect(screen.getByRole('button', { name: 'Create blank workflow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Or start from a blank workflow' })).toBeNull();
  });

  it('lets a platform ADMIN create a workflow for no team', async () => {
    state.templates = [base];
    state.authoring = {
      global: true,
      isLoading: false,
      teams: [{ id: 'team-1', name: 'Payments' }],
    };
    useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
    render(<TemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Team/ }).textContent).toContain(
      'No team (platform-wide)'
    );
  });

  it('asks a lead who leads several teams to choose one, and sends the choice', async () => {
    state.templates = [base];
    state.authoring = {
      global: false,
      isLoading: false,
      teams: [
        { id: 'team-1', name: 'Payments' },
        { id: 'team-2', name: 'Data' },
      ],
    };
    useAuthStore.setState({ user: { role: 'LEAD' } } as never);
    idle.mutateAsync.mockResolvedValue({ data: { id: 'new-1' } });
    render(<TemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Blank' }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'my-flow' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workflow' }));
    expect(await screen.findByText('Choose the team that will own the workflow')).toBeTruthy();
    expect(idle.mutateAsync).not.toHaveBeenCalled();
    // Only the teams the caller leads are on offer.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Team/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Payments', 'Data'])
    );
    fireEvent.click(screen.getByRole('option', { name: 'Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create blank workflow' }));
    await waitFor(() => expect(idle.mutateAsync).toHaveBeenCalled());
    expect(idle.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      name: 'my-flow',
      teamId: 'team-2',
    });
  });

  it('defaults the team from ?team= when the caller leads it', async () => {
    state.templates = [base];
    state.member = [{ id: 'team-1', name: 'Payments', slug: 'payments' }];
    state.authoring = {
      global: false,
      isLoading: false,
      teams: [
        { id: 'team-1', name: 'Payments' },
        { id: 'team-2', name: 'Data' },
      ],
    };
    nav.query = 'team=payments';
    useAuthStore.setState({ user: { role: 'LEAD' } } as never);
    render(<TemplatesPage />);
    expect(screen.getByTestId('team-chip').textContent).toContain('Payments');
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Team/ }).textContent).toContain('Payments');
  });

  it('keeps New workflow off for someone who leads no team', () => {
    state.templates = [base];
    useAuthStore.setState({ user: { role: 'LEAD' } } as never);
    render(<TemplatesPage />);
    expect(
      (screen.getByRole('button', { name: 'New workflow' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(/Lead a team to author workflows for it/)).toBeTruthy();
  });
});
