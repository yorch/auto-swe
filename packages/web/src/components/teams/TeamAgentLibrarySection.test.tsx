// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const idle = { isPending: false, mutateAsync: vi.fn() };
const createMutation = { isPending: false, mutateAsync: vi.fn() };
const updateMutation = { isPending: false, mutateAsync: vi.fn() };
const teamAgents: { data: unknown[] } = { data: [] };
vi.mock('@/hooks/useAgentLibrary', () => ({
  useCreateTeamAgent: () => createMutation,
  useDeleteTeamAgent: () => idle,
  useTeamAgentOptions: () => ({
    data: [{ key: 'reviewer', modelSpec: 'anthropic/x', name: 'Reviewer' }],
  }),
  useTeamAgents: () => ({
    data: teamAgents.data,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useUpdateTeamAgent: () => updateMutation,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => false }));
vi.mock('@/hooks/useMcpConnections', () => ({ useMcpConnections: () => ({ data: [] }) }));
vi.mock('@/components/modelConfig/ModelSpecPicker', () => ({ ModelSpecPicker: () => null }));
vi.mock('@/hooks/useSkills', () => ({ useTeamSkills: () => ({ data: [] }) }));

const { TeamAgentLibrarySection } = await import('./TeamAgentLibrarySection');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

describe('TeamAgentLibrarySection', () => {
  it('picks the parent agent from the team-readable list instead of free text', () => {
    render(<TeamAgentLibrarySection teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New override' }));
    fireEvent.click(screen.getByRole('radio', { name: /Inherit from another agent/ }));
    expect(screen.getByRole('combobox', { name: 'Inherit model from' })).toBeTruthy();
    expect(screen.queryByLabelText(/Inherit model from \(agent key\)/)).toBeNull();
  });

  it('shows the catalog and credential warnings of a saved override', async () => {
    createMutation.mutateAsync.mockResolvedValueOnce({
      catalogWarnings: ['No price for acme/x.'],
      credentialWarnings: ['No credential for acme.'],
      data: {},
      runtimeWarnings: ['harnessAgent (inherits from reviewer)'],
    });
    render(<TeamAgentLibrarySection teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New override' }));
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Create|Save)/ }));
    await waitFor(() => expect(createMutation.mutateAsync).toHaveBeenCalled());
    expect(await screen.findByText(/Model catalog: No price for acme\/x\./)).toBeTruthy();
    expect(screen.getByText(/Credentials: No credential for acme\./)).toBeTruthy();
    expect(screen.getByText(/harnessAgent \(inherits from reviewer\)/)).toBeTruthy();
    expect(screen.getByText(/agents on the Claude Code harness inherit this model/)).toBeTruthy();
  });

  it('says a blank prompt falls back to the built-in default, not the platform-wide prompt', () => {
    render(<TeamAgentLibrarySection teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New override' }));
    expect(screen.getByText(/built-in default prompt/)).toBeTruthy();
    expect(screen.queryByText(/inherit the global prompt/)).toBeNull();
  });

  it('shows the gateway’s refusal of an override with no model', async () => {
    createMutation.mutateAsync.mockRejectedValueOnce(
      new Error('An agent needs a model: set a model spec, or an agent to inherit the model from.')
    );
    render(<TeamAgentLibrarySection teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New override' }));
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Create|Save)/ }));
    expect(await screen.findByText(/An agent needs a model/)).toBeTruthy();
  });

  it('saves an edited reasoning level, and only what changed', async () => {
    teamAgents.data = [
      {
        createdAt: '2026-01-01T00:00:00.000Z',
        credentialId: null,
        description: null,
        id: 'agent-1',
        inheritsModelFrom: 'reviewer',
        isActive: true,
        isBuiltIn: false,
        isVerified: true,
        key: 'reviewer',
        mcpConnectionId: null,
        modelSpec: null,
        name: 'Reviewer',
        orgId: null,
        origin: null,
        reasoning: null,
        runtime: null,
        scope: 'TEAM',
        skillRefs: [],
        systemPrompt: 'Review carefully.',
        teamId: 't-1',
        toolKeys: null,
        version: 1,
        workflowTemplateId: null,
      },
    ];
    updateMutation.mutateAsync.mockResolvedValueOnce({ data: {} });
    try {
      render(<TeamAgentLibrarySection teamId="t-1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit reviewer' }));
      const reasoning = screen.getByRole('combobox', { name: /Reasoning/ });
      // React Aria opens the list only while the input is focused.
      act(() => reasoning.focus());
      fireEvent.change(reasoning, { target: { value: 'High' } });
      fireEvent.click(screen.getByRole('option', { name: 'High' }));
      fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
      await waitFor(() => expect(updateMutation.mutateAsync).toHaveBeenCalled());
      expect(updateMutation.mutateAsync).toHaveBeenCalledWith({
        body: { reasoning: 'high' },
        id: 'agent-1',
      });
    } finally {
      teamAgents.data = [];
    }
  });
});
