// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const idle = { isPending: false, mutateAsync: vi.fn() };
const createMutation = { isPending: false, mutateAsync: vi.fn() };
vi.mock('@/hooks/useAgentLibrary', () => ({
  useCreateTeamAgent: () => createMutation,
  useDeleteTeamAgent: () => idle,
  useTeamAgentOptions: () => ({
    data: [{ key: 'reviewer', modelSpec: 'anthropic/x', name: 'Reviewer' }],
  }),
  useTeamAgents: () => ({ data: [], isFetching: false, isLoading: false, refetch: vi.fn() }),
  useUpdateTeamAgent: () => idle,
}));
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
    });
    render(<TeamAgentLibrarySection teamId="t-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New override' }));
    fireEvent.change(screen.getByLabelText(/^Key/), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: /^(Create|Save)/ }));
    await waitFor(() => expect(createMutation.mutateAsync).toHaveBeenCalled());
    expect(await screen.findByText(/Model catalog: No price for acme\/x\./)).toBeTruthy();
    expect(screen.getByText(/Credentials: No credential for acme\./)).toBeTruthy();
  });
});
