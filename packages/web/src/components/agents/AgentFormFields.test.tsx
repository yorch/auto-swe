// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { AgentFormFields } from './AgentFormFields';

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
    expect(screen.getByLabelText('Model spec (optional)')).toBeTruthy();
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
    expect(screen.getByLabelText('Model spec')).toBeTruthy();
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
});
