// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { withQuery } from '@/test/rtl-helpers';
import AgentLibraryPage from './page';

const { modalProps, state } = vi.hoisted(() => ({
  modalProps: { current: null as null | { agents: AgentRow[]; open: boolean } },
  state: { admin: true, agents: [] as AgentRow[] },
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

vi.mock('@/hooks/useAgentLibrary', () => ({
  useAgentLibrary: () => ({
    data: state.agents,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useCreateAgent: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDeleteAgent: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAgent: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useAdmin', () => ({ useOrganizationDirectory: () => ({ data: [] }) }));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => state.admin }));
vi.mock('@/hooks/useMcpConnections', () => ({ useMcpConnections: () => ({ data: [] }) }));
vi.mock('@/hooks/useModelConfig', () => ({ useAdminCredentials: () => ({ data: [] }) }));
vi.mock('@/hooks/useReadiness', () => ({
  useReadiness: () => ({ data: { items: [], providers: [] } }),
}));
vi.mock('@/hooks/useSkills', () => ({ useSkills: () => ({ data: [] }) }));
vi.mock('@/hooks/useSlackChannels', () => ({ useSlackChannels: () => ({ data: [] }) }));
vi.mock('@/hooks/useTeams', () => ({ useTeams: () => ({ data: [] }) }));
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
  modalProps.current = null;
  state.admin = true;
  state.agents = [row('a1', 'Alpha', 'alpha'), row('b1', 'Beta', 'beta')];
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

  it('gives a non-admin no selection column and no way to change models in bulk', () => {
    state.admin = false;
    render(withQuery(<AgentLibraryPage />));

    expect(screen.queryByRole('checkbox', { name: 'Select all visible agents' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select alpha' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
    expect(modalProps.current).toBeNull();
  });
});
