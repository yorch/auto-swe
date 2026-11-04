// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ templates: [] as unknown[] }));
const idle = { isError: false, isLoading: false, isPending: false, mutateAsync: vi.fn() };

const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/library',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock('@/hooks/useTeams', () => ({ useLedTeamIds: () => new Set<string>() }));
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
  it('says why a system-managed workflow has no Run button', () => {
    state.templates = [base, { ...base, id: 't-2', name: 'Channel Assistant', team: null }];
    render(<TemplatesPage />);
    expect(
      screen.getAllByText(
        'No Run button: the platform starts this one itself, for channel assistants.'
      )
    ).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Run Ticket to PR' })).toBeTruthy();
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
    useAuthStore.setState({ user: { role: 'ADMIN' } } as never);
    render(<TemplatesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Blank' }));
    expect(screen.getByRole('button', { name: 'Create blank workflow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Or start from a blank workflow' })).toBeNull();
  });
});
