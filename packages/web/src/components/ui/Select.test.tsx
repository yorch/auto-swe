// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const OPTIONS = [
  { label: 'All statuses', value: '' },
  { label: 'Running', value: 'RUNNING' },
  { label: 'Failed', value: 'FAILED' },
];

function openAndPick(trigger: HTMLElement, optionName: string) {
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: optionName }));
}

describe('Select', () => {
  it('keeps working when options reorder after mount', () => {
    // A picker seeded with its current value, then filled when its list loads: the seeded
    // option moves position. Unkeyed items would change id and React Aria would throw.
    const { rerender } = render(
      <Select label="Agent" onChange={() => {}} options={[{ label: 'b', value: 'b' }]} value="b" />
    );
    rerender(
      <Select
        label="Agent"
        onChange={() => {}}
        options={[
          { label: 'a', value: 'a' },
          { label: 'b', value: 'b' },
        ]}
        value="b"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /agent/i }));
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace('✓', ''))).toEqual([
      'a',
      'b',
    ]);
  });

  it('is named by its label and shows the selected option', () => {
    render(<Select label="Status" onChange={() => {}} options={OPTIONS} value="FAILED" />);
    const trigger = screen.getByRole('button', { name: /status/i });
    expect(trigger.textContent).toContain('Failed');
  });

  it('reports the picked value', () => {
    const onChange = vi.fn();
    render(<Select label="Status" onChange={onChange} options={OPTIONS} value="" />);
    openAndPick(screen.getByRole('button', { name: /status/i }), 'Running');
    expect(onChange).toHaveBeenCalledWith('RUNNING');
  });

  it('round-trips an empty-string option value', () => {
    const onChange = vi.fn();
    render(<Select label="Status" onChange={onChange} options={OPTIONS} value="RUNNING" />);
    openAndPick(screen.getByRole('button', { name: /status/i }), 'All statuses');
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('shows the placeholder when the value matches no option', () => {
    render(
      <Select
        label="Status"
        onChange={() => {}}
        options={OPTIONS.slice(1)}
        placeholder="Pick one"
        value="nope"
      />
    );
    expect(screen.getByRole('button', { name: /status/i }).textContent).toContain('Pick one');
  });

  it('keeps forms working: name and required reach a hidden native select', () => {
    const { container } = render(
      <form>
        <Select
          label="Status"
          name="status"
          onChange={() => {}}
          options={OPTIONS.slice(1)}
          required
          value="FAILED"
        />
      </form>
    );
    const native = container.querySelector('select[name="status"]') as HTMLSelectElement;
    expect(native).toBeTruthy();
    expect(native.required).toBe(true);
    expect(native.value).toBe('FAILED');
  });

  it('submits an empty-string option as "" — not an internal key', () => {
    const { container } = render(
      <form>
        <Select label="Status" name="status" onChange={() => {}} options={OPTIONS} value="" />
      </form>
    );
    const form = container.querySelector('form') as HTMLFormElement;
    expect(new FormData(form).get('status')).toBe('');
  });

  it('treats a selected "" option as missing when required, like a native select', () => {
    const { container } = render(
      <form>
        <Select
          label="Status"
          name="status"
          onChange={() => {}}
          options={OPTIONS}
          required
          value=""
        />
      </form>
    );
    const native = container.querySelector('select[name="status"]') as HTMLSelectElement;
    expect(native.validity.valueMissing).toBe(true);
  });

  it('never blocks submit because it is showing an error', () => {
    // An error the caller displays is advice, not a validity flag: the form
    // must still submit so the caller can re-validate.
    const { container } = render(
      <form>
        <Select
          error="That status is retired"
          label="Status"
          name="status"
          onChange={() => {}}
          options={OPTIONS}
          required
          value="FAILED"
        />
      </form>
    );
    expect((container.querySelector('form') as HTMLFormElement).checkValidity()).toBe(true);
  });

  it('blocks submit when required and empty, and says so', () => {
    const { container } = render(
      <form>
        <Select
          label="Status"
          name="status"
          onChange={() => {}}
          options={OPTIONS.slice(1)}
          required
          value=""
        />
      </form>
    );
    const form = container.querySelector('form') as HTMLFormElement;
    let valid = true;
    act(() => {
      valid = form.checkValidity();
    });
    expect(valid).toBe(false);
    expect(screen.getByText('Choose an option')).toBeTruthy();
  });

  it('shows only the selected text in the trigger, not the option row', () => {
    render(
      <Select
        label="Status"
        onChange={() => {}}
        options={[{ description: 'Still going', label: 'Running', value: 'RUNNING' }]}
        value="RUNNING"
      />
    );
    const trigger = screen.getByRole('button', { name: /status/i });
    expect(trigger.textContent).toContain('Running');
    expect(trigger.textContent).not.toContain('Still going');
  });

  it('takes an aria-label when there is no visible label', () => {
    render(<Select aria-label="Sort" onChange={() => {}} options={OPTIONS} value="" />);
    expect(screen.getByRole('button', { name: /sort/i })).toBeTruthy();
  });

  it('describes the field by its hint, and by its error instead when invalid', () => {
    const { rerender } = render(
      <Select
        hint="Filters the list"
        label="Status"
        onChange={() => {}}
        options={OPTIONS}
        value=""
      />
    );
    const describedBy = () =>
      screen.getByRole('button', { name: /status/i }).getAttribute('aria-describedby') ?? '';
    const textOf = (ids: string) =>
      ids
        .split(' ')
        .map((i) => document.getElementById(i)?.textContent)
        .join(' ');
    expect(textOf(describedBy())).toContain('Filters the list');

    rerender(
      <Select
        error="Pick a status"
        hint="Filters the list"
        label="Status"
        onChange={() => {}}
        options={OPTIONS}
        value=""
      />
    );
    expect(textOf(describedBy())).toContain('Pick a status');
  });
});
