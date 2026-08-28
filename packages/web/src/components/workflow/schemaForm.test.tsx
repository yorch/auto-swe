import { render, screen } from '@testing-library/react';
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
    const select = screen.getByLabelText(/Connection id/i) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.options.length).toBe(2);
    expect(select.textContent).toContain('My Notion');
    expect(select.textContent).not.toContain('acme');
  });
});
