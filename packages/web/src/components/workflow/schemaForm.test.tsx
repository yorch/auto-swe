import { fireEvent, render, screen } from '@testing-library/react';
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildInitialPayload, SchemaFieldInput, validatePayload } from './schemaForm';

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

  it('labels a field by its title, and renders a choice list as checkboxes', () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldInput
        name="fixCategories"
        onChange={onChange}
        prop={{
          items: { enum: ['regression', 'test_bug'], type: 'string' },
          title: 'Fix these',
          type: 'array',
        }}
        value={['regression']}
      />
    );
    expect(screen.getByText('Fix these')).toBeTruthy();
    expect((screen.getByLabelText('regression') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText('test bug'));
    expect(onChange).toHaveBeenCalledWith(['regression', 'test_bug']);
  });
});

describe('buildInitialPayload / validatePayload', () => {
  const schema = {
    properties: {
      cats: {
        default: ['a'],
        items: { enum: ['a', 'b'], type: 'string' as const },
        minItems: 1,
        type: 'array' as const,
      },
      n: { default: 2, maximum: 5, minimum: 0, type: 'number' as const },
    },
    type: 'object' as const,
  };

  it('starts from the declared defaults', () => {
    expect(buildInitialPayload(schema)).toEqual({ cats: ['a'], n: 2 });
  });

  it('reports bounds and an empty choice list', () => {
    expect(validatePayload(schema, { cats: [], n: 6 })).toEqual({
      cats: 'Choose at least one',
      n: 'Must be at most 5',
    });
  });
});
