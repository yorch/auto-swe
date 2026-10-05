// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SkillOption } from '@/hooks/useSkills';
import {
  ALL_TOOL_KEYS,
  cleanAgentPayload,
  SkillRefEditor,
  ToolKeysEditor,
} from './AgentEditorFields';

/**
 * These fields are rendered by two pages with deliberately different chrome —
 * the GLOBAL library labels the add-skill Select and shows an empty hint, the
 * per-team section shows neither. The prop-driven differences are the whole
 * reason one component can serve both, so they are what this file pins.
 */

const SKILLS: SkillOption[] = [
  { description: 'Write the test first', id: 's1', isBuiltIn: true, name: 'tdd' },
  { description: 'Review a diff', id: 's2', isBuiltIn: false, name: 'code-review' },
];

describe('SkillRefEditor', () => {
  it('lists attached skills by name and leaves them out of the add options', () => {
    render(
      <SkillRefEditor onChange={vi.fn()} refs={[{ skillId: 's1', sortOrder: 0 }]} skills={SKILLS} />
    );

    expect(screen.getByText('tdd')).toBeTruthy();
    const input = screen.getByRole('combobox', { name: 'Add skill' }) as HTMLInputElement;
    expect(input.placeholder).toBe('+ Add skill…');
    // Focus alone no longer opens the list; the chevron shows every option.
    fireEvent.click(screen.getByRole('button', { name: /show options/i }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['code-review']);
  });

  it('appends the picked skill with the next sortOrder', () => {
    const onChange = vi.fn();
    render(
      <SkillRefEditor
        onChange={onChange}
        refs={[{ skillId: 's1', sortOrder: 0 }]}
        skills={SKILLS}
      />
    );

    const input = screen.getByRole('combobox', { name: 'Add skill' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'code' } });
    fireEvent.click(screen.getByRole('option', { name: 'code-review' }));

    expect(onChange).toHaveBeenCalledWith([
      { skillId: 's1', sortOrder: 0 },
      { skillId: 's2', sortOrder: 1 },
    ]);
  });

  it('clears the typed filter once a skill is added', () => {
    const { rerender } = render(<SkillRefEditor onChange={vi.fn()} refs={[]} skills={SKILLS} />);
    const input = screen.getByRole('combobox', { name: 'Add skill' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'code' } });
    fireEvent.click(screen.getByRole('option', { name: 'code-review' }));
    rerender(
      <SkillRefEditor onChange={vi.fn()} refs={[{ skillId: 's2', sortOrder: 0 }]} skills={SKILLS} />
    );
    expect((screen.getByRole('combobox', { name: 'Add skill' }) as HTMLInputElement).value).toBe(
      ''
    );
  });

  it('renumbers sortOrder after a removal', () => {
    const onChange = vi.fn();
    render(
      <SkillRefEditor
        onChange={onChange}
        refs={[
          { skillId: 's1', sortOrder: 0 },
          { skillId: 's2', sortOrder: 1 },
        ]}
        skills={SKILLS}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove tdd' }));

    expect(onChange).toHaveBeenCalledWith([{ skillId: 's2', sortOrder: 0 }]);
  });

  it('renumbers sortOrder after a reorder', () => {
    const onChange = vi.fn();
    render(
      <SkillRefEditor
        onChange={onChange}
        refs={[
          { skillId: 's1', sortOrder: 0 },
          { skillId: 's2', sortOrder: 1 },
        ]}
        skills={SKILLS}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move tdd down' }));

    expect(onChange).toHaveBeenCalledWith([
      { skillId: 's2', sortOrder: 0 },
      { skillId: 's1', sortOrder: 1 },
    ]);
  });

  it('shows the empty hint only when one is supplied and nothing can be added', () => {
    const { unmount } = render(<SkillRefEditor onChange={vi.fn()} refs={[]} skills={[]} />);
    expect(screen.queryByText('No skills available.')).toBeNull();
    unmount();

    render(
      <SkillRefEditor emptyHint="No skills available." onChange={vi.fn()} refs={[]} skills={[]} />
    );
    expect(screen.getByText('No skills available.')).toBeTruthy();
  });

  it('labels the add-skill Select only while the list is empty', () => {
    const { unmount } = render(
      <SkillRefEditor label="Skills" onChange={vi.fn()} refs={[]} skills={SKILLS} />
    );
    expect(screen.getByRole('combobox', { name: 'Skills' })).toBeTruthy();
    unmount();

    render(
      <SkillRefEditor
        label="Skills"
        onChange={vi.fn()}
        refs={[{ skillId: 's1', sortOrder: 0 }]}
        skills={SKILLS}
      />
    );
    expect(screen.queryByRole('combobox', { name: 'Skills' })).toBeNull();
  });
});

describe('ToolKeysEditor', () => {
  it('hides the checkboxes and shows the inherit hint when toolKeys is null', () => {
    render(<ToolKeysEditor onChange={vi.fn()} value={null} />);

    expect(screen.getByText('Inherits all available tools')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('lets the caller override the inherit hint copy', () => {
    render(
      <ToolKeysEditor
        inheritHint="Agent inherits all available tools"
        onChange={vi.fn()}
        value={null}
      />
    );

    expect(screen.getByText('Agent inherits all available tools')).toBeTruthy();
  });

  it('switching to a custom selection starts from an empty list, not from all keys', () => {
    const onChange = vi.fn();
    render(<ToolKeysEditor onChange={onChange} value={null} />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('offers every tool key and toggles one at a time', () => {
    const onChange = vi.fn();
    render(<ToolKeysEditor onChange={onChange} value={['bash']} />);

    for (const key of ALL_TOOL_KEYS) {
      expect(screen.getByText(key)).toBeTruthy();
    }

    fireEvent.click(screen.getByLabelText('readFile'));
    expect(onChange).toHaveBeenCalledWith(['bash', 'readFile']);
  });

  it('unchecking custom selection restores inheritance rather than an empty list', () => {
    const onChange = vi.fn();
    render(<ToolKeysEditor onChange={onChange} value={[]} />);

    fireEvent.click(screen.getAllByRole('checkbox')[0]);

    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('ToolKeysEditor warnings', () => {
  it('warns when a custom selection has nothing ticked', () => {
    render(<ToolKeysEditor onChange={vi.fn()} value={[]} />);
    expect(screen.getByText(/No tools are ticked/)).toBeTruthy();
  });

  it('does not warn once a tool is ticked', () => {
    render(<ToolKeysEditor onChange={vi.fn()} value={['bash']} />);
    expect(screen.queryByText(/No tools are ticked/)).toBeNull();
  });

  it('warns when an MCP connection is bound but the mcp tool is not ticked', () => {
    render(<ToolKeysEditor mcpSelected onChange={vi.fn()} value={['bash']} />);
    expect(screen.getByText(/mcp tool is not ticked/)).toBeTruthy();
  });
});

describe('cleanAgentPayload', () => {
  it('drops empty strings and undefined but keeps null, 0 and false', () => {
    expect(
      cleanAgentPayload({
        description: '',
        inheritsModelFrom: undefined,
        key: 'implementer',
        sortOrder: 0,
        toolKeys: null,
        verified: false,
      })
    ).toEqual({ key: 'implementer', sortOrder: 0, toolKeys: null, verified: false });
  });
});
