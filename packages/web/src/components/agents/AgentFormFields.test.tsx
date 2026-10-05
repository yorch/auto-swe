// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpConnectionRow } from '@/hooks/useMcpConnections';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { AgentFormFields } from './AgentFormFields';

// The model field suggests catalog models; the form's own behaviour is under test.
vi.mock('@/hooks/useModelCatalog', () => ({ useModelCatalog: () => ({ data: [] }) }));

/**
 * One body serves the GLOBAL library and the per-team section, in create and
 * edit mode. The mode- and prop-driven differences are what this file pins.
 */

const VALUE = { key: 'reviewer', name: 'Reviewer' };
const CREDENTIAL = { id: 'c1', lastFour: 'abcd', provider: 'anthropic' } as ProviderCredentialRow;

describe('AgentFormFields', () => {
  it('create mode shows the key field and marks optional fields', () => {
    render(
      <AgentFormFields
        mcpConnections={[]}
        mode="create"
        onChange={vi.fn()}
        skills={[]}
        value={VALUE}
      />
    );

    expect(screen.getByLabelText('Key')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Model spec (optional)' })).toBeTruthy();
  });

  it('edit mode has no key field and plain labels', () => {
    render(
      <AgentFormFields
        mcpConnections={[]}
        mode="edit"
        onChange={vi.fn()}
        skills={[]}
        value={VALUE}
      />
    );

    expect(screen.queryByLabelText('Key')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model spec' })).toBeTruthy();
  });

  it('renders the credential override only when credentials are passed', () => {
    const { unmount } = render(
      <AgentFormFields
        mcpConnections={[]}
        mode="edit"
        onChange={vi.fn()}
        skills={[]}
        value={VALUE}
      />
    );
    expect(screen.queryByRole('combobox', { name: /credential override/i })).toBeNull();
    unmount();

    render(
      <AgentFormFields
        credentials={[CREDENTIAL]}
        mcpConnections={[]}
        mode="edit"
        onChange={vi.fn()}
        skills={[]}
        value={VALUE}
      />
    );
    expect(screen.getByRole('combobox', { name: /credential override/i })).toBeTruthy();
  });

  it('emits a single-field patch, mapping an empty select to null', () => {
    const onChange = vi.fn();
    render(
      <AgentFormFields
        credentials={[CREDENTIAL]}
        mcpConnections={[]}
        mode="edit"
        onChange={onChange}
        skills={[]}
        value={{ ...VALUE, credentialId: 'c1' }}
      />
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Critic' } });
    expect(onChange).toHaveBeenLastCalledWith({ name: 'Critic' });

    const credential = screen.getByRole('combobox', { name: /credential override/i });
    act(() => credential.focus());
    fireEvent.change(credential, { target: { value: 'None' } });
    fireEvent.click(screen.getByRole('option', { name: 'None (system default)' }));
    expect(onChange).toHaveBeenLastCalledWith({ credentialId: null });
  });

  it('offers own model or inheritance as alternatives and clears the other binding', () => {
    const onChange = vi.fn();
    render(
      <AgentFormFields
        mcpConnections={[]}
        mode="edit"
        onChange={onChange}
        parentAgents={[{ key: 'reviewer', modelSpec: 'anthropic/x', name: 'Reviewer' }]}
        skills={[]}
        value={{ ...VALUE, modelSpec: 'anthropic/x' }}
      />
    );
    expect((screen.getByRole('radio', { name: /Own model/ }) as HTMLInputElement).checked).toBe(
      true
    );
    fireEvent.click(screen.getByRole('radio', { name: /Inherit from another agent/ }));
    expect(onChange).toHaveBeenLastCalledWith({ credentialId: null, modelSpec: '' });
    expect(screen.getByRole('combobox', { name: 'Inherit model from' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Model spec' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Own model/ }));
    expect(onChange).toHaveBeenLastCalledWith({ inheritsModelFrom: '' });
  });

  it('starts on inheritance for an agent that only inherits', () => {
    render(
      <AgentFormFields
        mcpConnections={[]}
        mode="edit"
        onChange={vi.fn()}
        parentAgents={[{ key: 'reviewer', modelSpec: 'anthropic/x', name: 'Reviewer' }]}
        skills={[]}
        value={{ ...VALUE, inheritsModelFrom: 'reviewer', modelSpec: null }}
      />
    );
    expect(
      (screen.getByRole('radio', { name: /Inherit from another agent/ }) as HTMLInputElement)
        .checked
    ).toBe(true);
  });

  it('lists only credentials for the chosen model provider', () => {
    const openai = { id: 'c2', lastFour: 'wxyz', provider: 'openai' } as ProviderCredentialRow;
    render(
      <AgentFormFields
        credentials={[CREDENTIAL, openai]}
        mcpConnections={[]}
        mode="edit"
        onChange={vi.fn()}
        skills={[]}
        value={{ ...VALUE, modelSpec: 'openai/gpt-6.1-sol' }}
      />
    );
    const credential = screen.getByRole('combobox', { name: /credential override/i });
    act(() => credential.focus());
    fireEvent.change(credential, { target: { value: '' } });
    expect(screen.queryByRole('option', { name: 'anthropic ···abcd' })).toBeNull();
    expect(screen.getByRole('option', { name: 'openai ···wxyz' })).toBeTruthy();
  });

  it('ticks the mcp tool when a connection is chosen with a custom tool list', () => {
    const onChange = vi.fn();
    render(
      <AgentFormFields
        mcpConnections={[
          { config: { url: 'https://m.test' }, id: 'm1', name: 'Docs' } as McpConnectionRow,
        ]}
        mode="edit"
        onChange={onChange}
        skills={[]}
        value={{ ...VALUE, toolKeys: ['bash'] }}
      />
    );
    const mcp = screen.getByRole('combobox', { name: /mcp connection/i });
    act(() => mcp.focus());
    fireEvent.change(mcp, { target: { value: 'Docs' } });
    fireEvent.click(screen.getByRole('option', { name: /Docs/ }));
    expect(onChange).toHaveBeenLastCalledWith({ mcpConnectionId: 'm1', toolKeys: ['bash', 'mcp'] });
  });
});
