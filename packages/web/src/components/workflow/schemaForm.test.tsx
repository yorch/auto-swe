import { fireEvent, render, screen } from '@testing-library/react';
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { SchemaFieldInput } from './schemaForm';

vi.mock('@/hooks/useRepositories', () => ({
  useRepositories: () => ({
    data: [
      {
        id: 'conn-1',
        name: 'My Notion',
        organizationName: null,
        repoName: null,
        type: 'notion',
      },
      {
        id: 'conn-2',
        name: null,
        organizationName: 'acme',
        repoName: 'repo',
        type: 'git_repo',
      },
    ],
  }),
}));

describe('SchemaFieldInput', () => {
  it('renders a connection picker filtered by connectionType', () => {
    render(
      <SchemaFieldInput
        name="connectionId"
        onChange={() => undefined}
        prop={{ connectionType: 'notion', type: 'connection' }}
        value=""
      />
    );
    const input = screen.getByRole('combobox', { name: /Connection id/i });
    expect(input).toBeTruthy();
    // Focus alone no longer opens the list; the chevron shows every option.
    fireEvent.click(screen.getByRole('button', { name: /show options/i }));
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toContain('My Notion');
    expect(screen.queryByText(/acme/)).toBeNull();
  });
});
