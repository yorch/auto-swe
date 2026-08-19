// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
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
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['+ Add skill…', 'code-review']);
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

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's2' } });

    expect(onChange).toHaveBeenCalledWith([
      { skillId: 's1', sortOrder: 0 },
      { skillId: 's2', sortOrder: 1 },
    ]);
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

    fireEvent.click(screen.getAllByRole('button', { name: '×' })[0]);

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

    fireEvent.click(screen.getAllByRole('button', { name: '↓' })[0]);

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
    expect(screen.getByLabelText('Skills')).toBeTruthy();
    unmount();

    render(
      <SkillRefEditor
        label="Skills"
        onChange={vi.fn()}
        refs={[{ skillId: 's1', sortOrder: 0 }]}
        skills={SKILLS}
      />
    );
    expect(screen.queryByLabelText('Skills')).toBeNull();
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
